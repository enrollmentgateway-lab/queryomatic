/**
 * Queryomatic Cloudflare Worker
 *
 * REFRESH FLOW:
 *
 * POST /api/options/refresh
 *     ↓
 * Slate options query
 *     ↓
 * { row: [{ key, value }, ...] }
 *     ↓
 * Group + deduplicate values
 *     ↓
 * Read current GitHub options.md
 *     ↓
 * Replace ONLY <!-- VALUES:key START/END --> blocks
 *     ↓
 * Preserve manually-written Context sections
 *     ↓
 * Commit updated options.md to GitHub
 *
 *
 * GENERATE FLOW:
 *
 * POST /api/generate
 *     ↓
 * Read current options.md from GitHub
 *     ↓
 * Send options.md + user prompt to Claude
 *     ↓
 * Return Slate query parameters
 *
 *
 * RUN FLOW:
 *
 * POST /api/run
 *     ↓
 * Run main Slate query
 *
 *
 * Secrets:
 * - SLATE_TOKEN_PROMPTS
 * - SLATE_TOKEN_MAINDB
 * - ANTHROPIC_API_KEY
 * - GITHUB_TOKEN
 * - APP_PASSWORD
 * - SESSION_SECRET
 *
 * Vars:
 * - SLATE_OPTIONS_URL
 * - SLATE_QUERY_URL
 * - ALLOWED_ORIGIN
 */


// ============================================================
// CONFIG
// ============================================================

const GITHUB_OWNER = "enrollmentgateway-lab";
const GITHUB_REPO = "queryomatic";
const GITHUB_BRANCH = "main";
const GITHUB_OPTIONS_PATH = "options.md";

const GITHUB_API_URL =
  `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_OPTIONS_PATH}`;

const EXPORT_CACHE_PREFIX = "export-run:";
const EXPORT_TTL_SECONDS = 15 * 60;



// ============================================================
// DEBUG HELPERS
// ============================================================

function requestId() {
  return crypto.randomUUID().slice(0, 8);
}


function logInfo(id, message, details = {}) {
  console.log(`[${id}] ${message}`, details);
}


function logError(id, message, details = {}) {
  console.error(`[${id}] ${message}`, details);
}


function safeUrl(urlString) {
  try {
    const url = new URL(urlString);

    for (const key of [
      "token",
      "access_token",
      "api_key",
    ]) {
      if (url.searchParams.has(key)) {
        url.searchParams.set(
          key,
          "[REDACTED]"
        );
      }
    }

    return url.toString();

  } catch {
    return "[INVALID URL]";
  }
}


function secretStatus(value) {
  if (!value) {
    return "MISSING";
  }

  return `SET (${value.length} characters)`;
}


// ============================================================
// CORS / JSON
// ============================================================

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin":
      env.ALLOWED_ORIGIN || "*",

    "Access-Control-Allow-Methods":
      "GET,POST,OPTIONS",

    "Access-Control-Allow-Headers":
      "Content-Type",

    "Access-Control-Expose-Headers":
      "Content-Disposition",

    "Access-Control-Allow-Credentials":
      "true",

    "Vary":
      "Origin",
  };
}


function json(data, env, status = 200, extraHeaders = {}) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        "Content-Type": "application/json",
        ...corsHeaders(env),
        ...extraHeaders,
      },
    }
  );
}


// ============================================================
// SHARED-PASSWORD SESSION AUTHENTICATION
// ============================================================

const SESSION_COOKIE = "queryomatic_session";
const SESSION_DURATION_SECONDS = 8 * 60 * 60;
const LOGIN_WINDOW_SECONDS = 15 * 60;
const MAX_LOGIN_ATTEMPTS = 5;

function base64UrlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value) {
  const padded = String(value).replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - String(value).length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function hmacSha256(secret, text) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text)));
}

function timingSafeEqual(first, second) {
  if (first.length !== second.length) return false;
  let result = 0;
  for (let i = 0; i < first.length; i++) result |= first[i] ^ second[i];
  return result === 0;
}

function cookieValue(request, name) {
  const match = request.headers.get("Cookie")?.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? match[1] : null;
}

async function createSession(env) {
  if (!env.SESSION_SECRET) throw new Error("SESSION_SECRET is missing");
  const payload = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + SESSION_DURATION_SECONDS })));
  const signature = base64UrlEncode(await hmacSha256(env.SESSION_SECRET, payload));
  return `${payload}.${signature}`;
}

async function hasValidSession(request, env) {
  if (!env.SESSION_SECRET) return false;
  const token = cookieValue(request, SESSION_COOKIE);
  if (!token || token.split(".").length !== 2) return false;
  try {
    const [payload, providedSignature] = token.split(".");
    const expectedSignature = base64UrlEncode(await hmacSha256(env.SESSION_SECRET, payload));
    if (!timingSafeEqual(base64UrlDecode(providedSignature), base64UrlDecode(expectedSignature))) return false;
    const { exp } = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload)));
    return Number.isInteger(exp) && exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

async function passwordMatches(password, expectedPassword) {
  const encoder = new TextEncoder();
  const suppliedHash = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(password)));
  const expectedHash = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(expectedPassword)));
  return timingSafeEqual(suppliedHash, expectedHash);
}

function clientIp(request) {
  return request.headers.get("CF-Connecting-IP") || "unknown";
}

async function loginIsRateLimited(env, request) {
  const attempts = Number(await env.OPTIONS_CACHE.get(`login-attempts:${clientIp(request)}`) || 0);
  return attempts >= MAX_LOGIN_ATTEMPTS;
}

async function recordFailedLogin(env, request) {
  const key = `login-attempts:${clientIp(request)}`;
  const attempts = Number(await env.OPTIONS_CACHE.get(key) || 0) + 1;
  await env.OPTIONS_CACHE.put(key, String(attempts), { expirationTtl: LOGIN_WINDOW_SECONDS });
}

function sessionCookie(value) {
  return `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${SESSION_DURATION_SECONDS}; HttpOnly; Secure; SameSite=None`;
}


// ============================================================
// UTF-8 / BASE64
// ============================================================

function utf8ToBase64(text) {
  const bytes =
    new TextEncoder().encode(text);

  let binary = "";

  const chunkSize = 0x8000;

  for (
    let i = 0;
    i < bytes.length;
    i += chunkSize
  ) {

    const chunk =
      bytes.subarray(
        i,
        i + chunkSize
      );

    binary +=
      String.fromCharCode(...chunk);
  }

  return btoa(binary);
}


function base64ToUtf8(base64) {
  const cleaned =
    String(base64 || "")
      .replace(/\s/g, "");

  const binary =
    atob(cleaned);

  const bytes =
    new Uint8Array(binary.length);

  for (
    let i = 0;
    i < binary.length;
    i++
  ) {
    bytes[i] =
      binary.charCodeAt(i);
  }

  return new TextDecoder()
    .decode(bytes);
}


// ============================================================
// GITHUB HELPERS
// ============================================================

function githubHeaders(env) {
  if (!env.GITHUB_TOKEN) {
    throw new Error("GITHUB_TOKEN is missing");
  }

  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    "User-Agent": "queryomatic-cloudflare-worker",
  };
}


// ============================================================
// GET OPTIONS.MD FROM GITHUB
// ============================================================

async function getGitHubOptionsFile(
  env,
  id
) {

  logInfo(
    id,
    "Fetching options.md from GitHub"
  );

  const url =
    `${GITHUB_API_URL}` +
    `?ref=${encodeURIComponent(GITHUB_BRANCH)}`;

  const resp = await fetch(
    url,
    {
      method: "GET",
      headers: githubHeaders(env),
    }
  );

  const responseText =
    await resp.text();

  logInfo(
    id,
    "GitHub options.md response",
    {
      status: resp.status,
      statusText: resp.statusText,
      body: responseText.slice(0, 2000),
    }
  );

  if (!resp.ok) {

    throw new Error(
      `Unable to read options.md from GitHub: ` +
      `HTTP ${resp.status} ${resp.statusText}. ` +
      `Response: ${responseText.slice(0, 1500)}`
    );
  }


  let data;

  try {
    data =
      JSON.parse(responseText);

  } catch {

    throw new Error(
      "GitHub returned invalid JSON while reading options.md"
    );
  }


  if (!data.sha) {
    throw new Error(
      "GitHub options.md response did not contain a SHA"
    );
  }


  // GitHub represents an intentionally empty file as content: "".
  // Accept that valid value so a Slate refresh can rebuild options.md.
  if (typeof data.content !== "string") {
    throw new Error(
      "GitHub options.md response did not contain file content"
    );
  }


  const markdown =
    base64ToUtf8(data.content);


  return {
    sha: data.sha,
    markdown,
  };
}


// ============================================================
// FETCH OPTIONS FROM SLATE
// ============================================================

async function fetchSlateOptions(
  env,
  id
) {

  logInfo(
    id,
    "Starting Slate OPTIONS request",
    {
      url:
        safeUrl(env.SLATE_OPTIONS_URL),

      token:
        secretStatus(
          env.SLATE_TOKEN_PROMPTS
        ),
    }
  );


  if (!env.SLATE_OPTIONS_URL) {

    throw new Error(
      "SLATE_OPTIONS_URL is missing"
    );
  }


  if (!env.SLATE_TOKEN_PROMPTS) {

    throw new Error(
      "SLATE_TOKEN_PROMPTS is missing"
    );
  }


  const resp = await fetch(
    env.SLATE_OPTIONS_URL,
    {
      method: "GET",

      headers: {
        Authorization:
          `Bearer ${env.SLATE_TOKEN_PROMPTS}`,

        Accept:
          "application/json",
      },
    }
  );


  const responseText =
    await resp.text();


  logInfo(
    id,
    "Slate OPTIONS response",
    {
      status: resp.status,
      statusText: resp.statusText,
      body: responseText.slice(0, 5000),
    }
  );


  if (!resp.ok) {

    throw new Error(
      `Slate OPTIONS request failed: ` +
      `HTTP ${resp.status} ${resp.statusText}. ` +
      `Response: ${responseText.slice(0, 2000)}`
    );
  }


  try {

    return JSON.parse(
      responseText
    );

  } catch {

    throw new Error(
      `Slate OPTIONS returned invalid JSON. ` +
      `Response: ${responseText.slice(0, 2000)}`
    );
  }
}


// ============================================================
// GROUP SLATE OPTIONS
// ============================================================

function groupSlateOptions(data) {

  const rows =
    Array.isArray(data?.row)
      ? data.row
      : [];


  const groups = {};

  let validRowCount = 0;


  for (const row of rows) {

    const key =
      row?.key == null
        ? ""
        : String(row.key).trim();


    const value =
      row?.value == null
        ? ""
        : String(row.value).trim();


    // Ignore null / blank rows
    if (!key || !value) {
      continue;
    }


    validRowCount++;


    if (!groups[key]) {
      groups[key] =
        new Set();
    }


    groups[key].add(value);
  }


  return {
    groups,
    validRowCount,
    totalRowCount: rows.length,
  };
}


// ============================================================
// REGEX HELPER
// ============================================================

function escapeRegExp(value) {

  return value.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );
}


// ============================================================
// BUILD VALUES BLOCK
// ============================================================

function buildValuesBlock(
  key,
  values
) {

  const start =
    `<!-- VALUES:${key} START -->`;

  const end =
    `<!-- VALUES:${key} END -->`;


  const list =
    values
      .map(
        value =>
          `- ${value}`
      )
      .join("\n");


  return `${start}

${list}

${end}`;
}


// ============================================================
// BUILD A BRAND NEW KEY SECTION
// ============================================================

function buildNewKeySection(
  key,
  values
) {

  const valuesBlock =
    buildValuesBlock(
      key,
      values
    );


  return `## ${key}

### Context

_Add context for this parameter here._

### Valid Values

${valuesBlock}`;
}


// ============================================================
// FIND MARKDOWN KEY SECTION
//
// Finds:
//
// ## program
//
// ...content...
//
// until the next:
//
// ## another-key
//
// or EOF.
// ============================================================

function findKeySection(
  markdown,
  key
) {

  const headingPattern =
    new RegExp(
      `^##\\s+${escapeRegExp(key)}\\s*$`,
      "mi"
    );


  const match =
    headingPattern.exec(markdown);


  if (!match) {
    return null;
  }


  const start =
    match.index;


  const afterHeading =
    match.index +
    match[0].length;


  const rest =
    markdown.slice(
      afterHeading
    );


  const nextHeading =
    /^##\s+/m.exec(rest);


  const end =
    nextHeading
      ? afterHeading +
        nextHeading.index
      : markdown.length;


  return {
    start,
    end,
    text:
      markdown.slice(
        start,
        end
      ),
  };
}


// ============================================================
// UPDATE OPTIONS.MD
//
// Important:
//
// JavaScript ONLY modifies:
//
// <!-- VALUES:key START -->
//
// ...
//
// <!-- VALUES:key END -->
//
// Everything else is preserved.
//
// If a key does not exist yet, a new section is created.
// ============================================================

function updateOptionsMarkdown(
  existingMarkdown,
  groups
) {

  let markdown =
    String(existingMarkdown || "")
      .replace(/\r\n/g, "\n");


  // If options.md is basically empty,
  // give it a useful title.
  if (!markdown.trim()) {

    markdown =
`# Queryomatic Options

> Parameter reference used by Queryomatic.

`;
  }


  const keys =
    Object.keys(groups)
      .sort(
        (a, b) =>
          a.localeCompare(
            b,
            undefined,
            {
              numeric: true,
              sensitivity: "base",
            }
          )
      );


  for (const key of keys) {

    const values =
      [...groups[key]]
        .sort(
          (a, b) =>
            a.localeCompare(
              b,
              undefined,
              {
                numeric: true,
                sensitivity: "base",
              }
            )
        );


    const valuesStart =
      `<!-- VALUES:${key} START -->`;

    const valuesEnd =
      `<!-- VALUES:${key} END -->`;


    const newValuesBlock =
      buildValuesBlock(
        key,
        values
      );


    // --------------------------------------------------------
    // CASE 1
    //
    // Existing generated block exists.
    //
    // Replace ONLY the contents between its markers.
    // --------------------------------------------------------

    if (
      markdown.includes(valuesStart) &&
      markdown.includes(valuesEnd)
    ) {

      const pattern =
        new RegExp(
          escapeRegExp(valuesStart) +
          "[\\s\\S]*?" +
          escapeRegExp(valuesEnd),
          "g"
        );


      markdown =
        markdown.replace(
          pattern,
          newValuesBlock
        );


      continue;
    }


    // --------------------------------------------------------
    // CASE 2
    //
    // The ## key section exists,
    // but it doesn't have VALUES markers yet.
    //
    // Preserve everything already inside that section
    // and append Valid Values at the bottom.
    // --------------------------------------------------------

    const section =
      findKeySection(
        markdown,
        key
      );


    if (section) {

      let sectionText =
        section.text
          .trimEnd();


      sectionText +=
`

### Valid Values

${newValuesBlock}

`;


      markdown =
        markdown.slice(
          0,
          section.start
        ) +
        sectionText +
        markdown.slice(
          section.end
        );


      continue;
    }


    // --------------------------------------------------------
    // CASE 3
    //
    // Brand new Slate key.
    //
    // Create a new section with an editable Context area.
    // --------------------------------------------------------

    const newSection =
      buildNewKeySection(
        key,
        values
      );


    markdown =
      markdown.trimEnd() +
      `\n\n${newSection}\n`;
  }


  return (
    markdown.trimEnd() +
    "\n"
  );
}


// ============================================================
// COMMIT OPTIONS.MD TO GITHUB
// ============================================================

async function commitOptionsMarkdown(
  env,
  id,
  markdown,
  currentSha
) {

  if (!env.GITHUB_TOKEN) {

    throw new Error(
      "GITHUB_TOKEN is missing"
    );
  }


  if (!currentSha) {

    throw new Error(
      "Cannot update options.md without its current GitHub SHA"
    );
  }


  logInfo(
    id,
    "Committing updated options.md to GitHub",
    {
      repo:
        `${GITHUB_OWNER}/${GITHUB_REPO}`,

      branch:
        GITHUB_BRANCH,

      path:
        GITHUB_OPTIONS_PATH,

      markdownLength:
        markdown.length,
    }
  );


  const encodedContent =
    utf8ToBase64(markdown);


  const body = {
    message:
      "Refresh Queryomatic options from Slate",

    content:
      encodedContent,

    sha:
      currentSha,

    branch:
      GITHUB_BRANCH,
  };


  const resp = await fetch(
  GITHUB_API_URL,
  {
    method: "PUT",

    headers: {
      ...githubHeaders(env),
      "Content-Type": "application/json",
    },

    body: JSON.stringify(body),
  }
);

const responseText = await resp.text();

logInfo(
  id,
  "GitHub commit response",
  {
    url: GITHUB_API_URL,
    status: resp.status,
    statusText: resp.statusText,
    contentType: resp.headers.get("content-type"),
    server: resp.headers.get("server"),
    cfRay: resp.headers.get("cf-ray"),
    body: responseText.slice(0, 3000),
  }
);


  if (!resp.ok) {

    throw new Error(
      `GitHub update failed: ` +
      `HTTP ${resp.status} ${resp.statusText}. ` +
      `Response: ${responseText.slice(0, 2000)}`
    );
  }


  let data;

  try {

    data =
      JSON.parse(responseText);

  } catch {

    throw new Error(
      "GitHub returned invalid JSON after updating options.md"
    );
  }


  return data;
}


// ============================================================
// REFRESH OPTIONS FROM SOURCE
// ============================================================

async function refreshOptionsFromSlate(
  env,
  id
) {

  // ----------------------------------------------------------
  // STEP 1
  // Query Slate
  // ----------------------------------------------------------

  const slateData =
    await fetchSlateOptions(
      env,
      id
    );


  // ----------------------------------------------------------
  // STEP 2
  // Group key/value pairs
  // ----------------------------------------------------------

  const {
    groups,
    validRowCount,
    totalRowCount,
  } =
    groupSlateOptions(
      slateData
    );


  const keys =
    Object.keys(groups);


  logInfo(
    id,
    "Slate options grouped",
    {
      totalRowCount,
      validRowCount,
      keyCount: keys.length,
      keys,
    }
  );


  // ----------------------------------------------------------
  // SAFETY CHECK
  //
  // Never overwrite GitHub if Slate returned
  // no useful data.
  // ----------------------------------------------------------

  if (
    validRowCount === 0 ||
    keys.length === 0
  ) {

    throw new Error(
      `Slate returned ${totalRowCount} rows but ` +
      `0 valid key/value option rows. ` +
      `options.md was NOT changed.`
    );
  }


  // ----------------------------------------------------------
  // STEP 3
  // Read current options.md
  // ----------------------------------------------------------

  const currentFile =
    await getGitHubOptionsFile(
      env,
      id
    );


  // ----------------------------------------------------------
  // STEP 4
  // Replace generated values
  // ----------------------------------------------------------

  const updatedMarkdown =
    updateOptionsMarkdown(
      currentFile.markdown,
      groups
    );


  // ----------------------------------------------------------
  // STEP 5
  // Don't create pointless commits
  // ----------------------------------------------------------

  if (
    updatedMarkdown ===
    currentFile.markdown
  ) {

    logInfo(
      id,
      "Options are already current; skipping GitHub commit"
    );


    return {
      updated: false,
      committed: false,

      message:
        "options.md is already up to date",

      keyCount:
        keys.length,

      validRowCount,
      totalRowCount,

      keys,
    };
  }


  // ----------------------------------------------------------
  // STEP 6
  // Commit updated file
  // ----------------------------------------------------------

  const githubResult =
    await commitOptionsMarkdown(
      env,
      id,
      updatedMarkdown,
      currentFile.sha
    );


  return {
    updated: true,
    committed: true,

    message:
      "options.md refreshed from Slate and committed to GitHub",

    keyCount:
      keys.length,

    validRowCount,
    totalRowCount,

    keys,

    commitSha:
      githubResult?.commit?.sha || null,

    commitUrl:
      githubResult?.commit?.html_url || null,
  };
}


// ============================================================
// ANTHROPIC
// ============================================================

async function generateQueryParams(
  env,
  id,
  userPrompt,
  optionsMarkdown
) {

  const currentDate =
    new Date()
      .toISOString()
      .slice(0, 10);

  logInfo(
    id,
    "Starting Anthropic request",
    {
      promptLength:
        userPrompt.length,

      optionsLength:
        optionsMarkdown.length,

      apiKey:
        secretStatus(
          env.ANTHROPIC_API_KEY
        ),
    }
  );


  if (!env.ANTHROPIC_API_KEY) {

    throw new Error(
      "ANTHROPIC_API_KEY is missing"
    );
  }


  const systemPrompt =
`You translate a staff member's plain-English request into query parameters for a Slate admissions export.

You have a Markdown reference document called options.md.

Each parameter is represented by a section such as:

## program

### Context

Human-written instructions explaining how the parameter should be interpreted.

### Valid Values

A generated list containing the exact valid values from Slate.

Use BOTH the Context and Valid Values when interpreting the user's request.

The Context explains aliases, terminology, behavior, and interpretation.

The Valid Values section contains values that may actually be sent to Slate.

Do not invent parameter values.

If the user does not specify a parameter, leave that parameter as an empty string.

If the user's language corresponds to an alias or instruction in a Context section, translate it to the appropriate exact value from Valid Values.

The output keys are Slate query parameter names. Map them to these options.md sections:

- term: academic_term
- year: academic_year
- status: person_status
- pipeline: pipelines
- teachingsite: teachingsites
- program: program
- app_code: Decision Code

Use the exact Valid Values from the mapped section. For a shorthand location such as "Burbank", select the one teaching-site value that contains that location name.

Today is ${currentDate}. Resolve relative academic-term language when possible. For example, "this fall" means term "Fall" and the academic-year value whose first year is this calendar year. Thus, during 2026, "this fall" maps to year "2026-2027".

When the user asks for "students", use the exact person_status value "Student" in the status output key, if it is a valid value.

When the user asks for "admitted students" or "admitted applications", set status to the exact person_status value "Student" and app_code to "AT", if those are valid values. When they specifically ask for provisionally admitted students, use app_code "ATP" instead.

Application Created Date is a date range. Use app_createddate_start for the inclusive beginning of the requested range and app_createddate_end for the inclusive end. Return dates in YYYY-MM-DD format. If the user provides only one boundary (for example, "created since January 1, 2026"), leave the other boundary empty. If they name a full month, use its first and last calendar dates. Do not use app_createddate.

OPTIONS.MD
============================================================

${optionsMarkdown}

============================================================
END OPTIONS.MD

Respond with ONLY a JSON object using exactly these keys:

{
  "term": "",
  "year": "",
  "status": "",
  "pipeline": "",
  "teachingsite": "",
  "program": "",
  "app_code": "",
  "app_createddate_start": "",
  "app_createddate_end": ""
}

No prose.
No explanation.
No markdown fences.`;


  const resp = await fetch(
    "https://api.anthropic.com/v1/messages",
    {
      method: "POST",

      headers: {
        "Content-Type":
          "application/json",

        "x-api-key":
          env.ANTHROPIC_API_KEY,

        "anthropic-version":
          "2023-06-01",
      },

      body:
        JSON.stringify({
          model:
            "claude-haiku-4-5-20251001",

          max_tokens:
            500,

          system:
            systemPrompt,

          messages: [
            {
              role: "user",
              content: userPrompt,
            },
          ],
        }),
    }
  );


  const responseText =
    await resp.text();


  logInfo(
    id,
    "Anthropic response",
    {
      status: resp.status,
      statusText: resp.statusText,
      body: responseText.slice(0, 5000),
    }
  );


  if (!resp.ok) {

    throw new Error(
      `Anthropic API error: ` +
      `HTTP ${resp.status} ${resp.statusText}. ` +
      `Response: ${responseText.slice(0, 2000)}`
    );
  }


  let data;

  try {

    data =
      JSON.parse(responseText);

  } catch {

    throw new Error(
      `Anthropic returned invalid JSON: ` +
      responseText.slice(0, 2000)
    );
  }


  if (!data.content) {

    throw new Error(
      "Anthropic response did not contain content"
    );
  }


  const text =
    data.content
      .map(
        block =>
          block.type === "text"
            ? block.text
            : ""
      )
      .join("");


  const cleaned =
    text
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim();


  logInfo(
    id,
    "Anthropic generated parameters",
    {
      response: cleaned,
    }
  );


  try {

    return JSON.parse(
      cleaned
    );

  } catch {

    throw new Error(
      `Anthropic returned invalid parameter JSON: ` +
      cleaned.slice(0, 2000)
    );
  }
}


// ============================================================
// MAIN SLATE QUERY
// ============================================================

async function runSlateQuery(
  env,
  id,
  params
) {

  logInfo(
    id,
    "Starting main Slate query",
    {
      baseUrl:
        safeUrl(
          env.SLATE_QUERY_URL
        ),

      token:
        secretStatus(
          env.SLATE_TOKEN_MAINDB
        ),

      params,
    }
  );


  if (!env.SLATE_QUERY_URL) {

    throw new Error(
      "SLATE_QUERY_URL is missing"
    );
  }


  if (!env.SLATE_TOKEN_MAINDB) {

    throw new Error(
      "SLATE_TOKEN_MAINDB is missing"
    );
  }


  const url =
    new URL(
      env.SLATE_QUERY_URL
    );


  url.searchParams.set(
    "output",
    "json"
  );


  for (
    const [key, value]
    of Object.entries(params)
  ) {

    url.searchParams.set(
      key,
      value ?? ""
    );
  }


  logInfo(
    id,
    "Final Slate query URL",
    {
      url:
        safeUrl(
          url.toString()
        ),
    }
  );


  const resp = await fetch(
    url.toString(),
    {
      method: "GET",

      headers: {
        Authorization:
          `Bearer ${env.SLATE_TOKEN_MAINDB}`,

        Accept:
          "application/json",
      },
    }
  );


  const responseText =
    await resp.text();


  logInfo(
    id,
    "Main Slate query response",
    {
      status: resp.status,
      statusText: resp.statusText,
      body: responseText.slice(0, 5000),
    }
  );


  if (!resp.ok) {

    throw new Error(
      `Slate MAIN query failed: ` +
      `HTTP ${resp.status} ${resp.statusText}. ` +
      `Response: ${responseText.slice(0, 2000)}`
    );
  }


  try {

    return JSON.parse(
      responseText
    );

  } catch {

    throw new Error(
      `Slate MAIN query returned invalid JSON: ` +
      responseText.slice(0, 2000)
    );
  }
}


// ============================================================
// CSV EXPORTS
// ============================================================

function slateRows(data) {
  if (Array.isArray(data)) return data;
  return Array.isArray(data?.row) ? data.row : [];
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[\",\n\r]/.test(text)
    ? `"${text.replace(/"/g, '""')}"`
    : text;
}

function rowsToCsv(rows) {
  if (!rows.length) return "";

  const columns = [...new Set(rows.flatMap((row) => Object.keys(row || {})))];
  const lines = [columns.map(csvCell).join(",")];

  for (const row of rows) {
    lines.push(columns.map((column) => csvCell(row?.[column])).join(","));
  }

  return lines.join("\r\n");
}


// ============================================================
// WORKER
// ============================================================

export default {

  async fetch(
    request,
    env
  ) {

    const id =
      requestId();


    const url =
      new URL(
        request.url
      );


    logInfo(
      id,
      "========== NEW REQUEST ==========",
      {
        method:
          request.method,

        pathname:
          url.pathname,

        search:
          url.search,
      }
    );


    // ========================================================
    // CORS
    // ========================================================

    if (
      request.method === "OPTIONS"
    ) {

      return new Response(
        null,
        {
          headers:
            corsHeaders(env),
        }
      );
    }


    try {

      // Login is the only endpoint that does not require a valid session.
      if (url.pathname === "/api/login" && request.method === "POST") {
        if (!env.APP_PASSWORD || !env.SESSION_SECRET) {
          throw new Error("APP_PASSWORD or SESSION_SECRET is missing");
        }
        if (await loginIsRateLimited(env, request)) {
          return json({ error: "Too many attempts. Try again in 15 minutes." }, env, 429);
        }

        const body = await request.json();
        if (!await passwordMatches(String(body?.password || ""), env.APP_PASSWORD)) {
          await recordFailedLogin(env, request);
          return json({ error: "Incorrect password" }, env, 401);
        }

        return json(
          { ok: true },
          env,
          200,
          { "Set-Cookie": sessionCookie(await createSession(env)) }
        );
      }

      if (!await hasValidSession(request, env)) {
        return json({ error: "Sign in required" }, env, 401);
      }

      if (url.pathname === "/api/session" && request.method === "GET") {
        return json({ ok: true }, env);
      }


      // ======================================================
      // GET CURRENT OPTIONS.MD
      //
      // Read-only.
      //
      // Does NOT query Slate.
      // Does NOT commit anything.
      // ======================================================

      if (
        url.pathname === "/api/options" &&
        request.method === "GET"
      ) {

        const file =
          await getGitHubOptionsFile(
            env,
            id
          );


        return json(
          {
            markdown:
              file.markdown,

            source:
              "github",

            repository:
              `${GITHUB_OWNER}/${GITHUB_REPO}`,

            branch:
              GITHUB_BRANCH,

            path:
              GITHUB_OPTIONS_PATH,

            requestId:
              id,
          },
          env
        );
      }


      // ======================================================
      // REFRESH FROM SOURCE
      //
      // POST only.
      //
      // Slate
      //   ↓
      // JS transformation
      //   ↓
      // options.md
      //   ↓
      // GitHub commit
      // ======================================================

      if (
        url.pathname ===
          "/api/options/refresh" &&

        request.method ===
          "POST"
      ) {

        logInfo(
          id,
          "Refresh from Source requested"
        );


        const result =
          await refreshOptionsFromSlate(
            env,
            id
          );


        return json(
          {
            ...result,
            requestId: id,
          },
          env
        );
      }


      // ======================================================
      // GENERATE QUERY PARAMETERS
      //
      // Reads options.md directly from GitHub.
      // ======================================================

      if (
        url.pathname ===
          "/api/generate" &&

        request.method ===
          "POST"
      ) {

        const body =
          await request.json();


        const prompt =
          body?.prompt;


        if (
          !prompt ||
          !String(prompt).trim()
        ) {

          return json(
            {
              error:
                "Missing 'prompt'",

              requestId:
                id,
            },
            env,
            400
          );
        }


        // Always get current
        // options.md from GitHub.
        const file =
          await getGitHubOptionsFile(
            env,
            id
          );


        const params =
          await generateQueryParams(
            env,
            id,
            String(prompt),
            file.markdown
          );


        return json(
          {
            params,
            requestId: id,
          },
          env
        );
      }


      // ======================================================
      // RUN MAIN SLATE QUERY
      // ======================================================

      if (
        url.pathname ===
          "/api/run" &&

        request.method ===
          "POST"
      ) {

        const body =
          await request.json();


        const params =
          body?.params;


        if (!params) {

          return json(
            {
              error:
                "Missing 'params'",

              requestId:
                id,
            },
            env,
            400
          );
        }


        const data =
          await runSlateQuery(
            env,
            id,
            params
          );


        return json(
          {
            data,
            requestId: id,
          },
          env
        );
      }


      // ======================================================
      // CREATE CSV EXPORT
      //
      // Generates query parameters from a prompt, runs the
      // main Slate query, and stores the CSV briefly in KV.
      // ======================================================

      if (
        url.pathname === "/api/export" &&
        request.method === "POST"
      ) {

        const body = await request.json();
        const prompt = body?.prompt;

        if (!prompt || !String(prompt).trim()) {
          return json(
            {
              error: "Missing 'prompt'",
              requestId: id,
            },
            env,
            400
          );
        }

        const file = await getGitHubOptionsFile(env, id);
        const params = await generateQueryParams(
          env,
          id,
          String(prompt),
          file.markdown
        );
        const data = await runSlateQuery(env, id, params);
        const rows = slateRows(data);
        const runId = crypto.randomUUID();

        await env.OPTIONS_CACHE.put(
          `${EXPORT_CACHE_PREFIX}${runId}`,
          rowsToCsv(rows),
          { expirationTtl: EXPORT_TTL_SECONDS }
        );

        return json(
          {
            runId,
            downloadUrl: new URL(`/api/export/${runId}`, url.origin).toString(),
            rowCount: rows.length,
            params,
            expiresInSeconds: EXPORT_TTL_SECONDS,
            requestId: id,
          },
          env,
          201
        );
      }


      // ======================================================
      // DOWNLOAD CSV EXPORT
      // ======================================================

      const exportMatch = url.pathname.match(
        /^\/api\/export\/([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})$/i
      );

      if (exportMatch && request.method === "GET") {
        const csv = await env.OPTIONS_CACHE.get(
          `${EXPORT_CACHE_PREFIX}${exportMatch[1]}`
        );

        if (csv === null) {
          return json(
            {
              error: "Export run was not found or has expired",
              requestId: id,
            },
            env,
            404
          );
        }

        return new Response(csv, {
          headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename=\"enrollment_export_${exportMatch[1]}.csv\"`,
            "Cache-Control": "no-store",
            ...corsHeaders(env),
          },
        });
      }


      // ======================================================
      // NOT FOUND
      // ======================================================

      return json(
        {
          error:
            "Not found",

          requestId:
            id,

          path:
            url.pathname,

          method:
            request.method,
        },
        env,
        404
      );


    } catch (err) {


      // ======================================================
      // ERROR
      // ======================================================

      logError(
        id,
        "REQUEST FAILED",
        {
          message:
            err?.message,

          name:
            err?.name,

          stack:
            err?.stack,
        }
      );


      return json(
        {
          error:
            err?.message ||
            "Unknown error",

          requestId:
            id,
        },
        env,
        500
      );
    }
  },
};
