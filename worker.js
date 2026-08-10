/**
 * Cloudflare Worker backend for the Slate NL Query Tool.
 *
 * Secrets (set with `wrangler secret put <NAME>`):
 *   SLATE_TOKEN_PROMPTS - Slate user token for the parameter-options query
 *   SLATE_TOKEN_MAINDB  - Slate user token for the main data query
 *   ANTHROPIC_API_KEY   - your Anthropic API key
 *
 * Bindings (in wrangler.toml):
 *   OPTIONS_CACHE (KV namespace) - caches the parameter option list
 *
 * Vars (in wrangler.toml [vars]):
 *   SLATE_QUERY_URL   - the query/run endpoint that returns application data
 *   SLATE_OPTIONS_URL - the query/run endpoint that returns valid parameter values
 *   ALLOWED_ORIGIN    - your GitHub Pages origin, e.g. https://yourorg.github.io
 */

const OPTIONS_CACHE_KEY = "param-options";
const OPTIONS_TTL_SECONDS = 60 * 60 * 12; // refresh twice a day

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(data, env, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(env) },
  });
}

async function fetchSlateOptions(env) {
  const resp = await fetch(env.SLATE_OPTIONS_URL, {
    headers: { Authorization: `Bearer ${env.SLATE_TOKEN_PROMPTS}` },
  });
  if (!resp.ok) throw new Error(`Slate options fetch failed: ${resp.status}`);
  return resp.json();
}

async function getOptions(env, forceRefresh = false) {
  if (!forceRefresh) {
    const cached = await env.OPTIONS_CACHE.get(OPTIONS_CACHE_KEY, "json");
    if (cached) return cached;
  }
  const fresh = await fetchSlateOptions(env);
  await env.OPTIONS_CACHE.put(OPTIONS_CACHE_KEY, JSON.stringify(fresh), {
    expirationTtl: OPTIONS_TTL_SECONDS,
  });
  return fresh;
}

async function generateQueryParams(env, userPrompt, options) {
  const systemPrompt = `You translate a staff member's plain-English request into query parameters for a Slate admissions export.

Valid parameter values (only use values found here; leave a field as an empty string if not mentioned or not matched):
${JSON.stringify(options)}

Respond with ONLY a JSON object with these keys: term, year, status, pipeline, teachingsite, program, app_code, app_createddate. No prose, no markdown fences.`;

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 500,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Anthropic API error: ${resp.status} ${text}`);
  }

  const data = await resp.json();
  const text = data.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  const cleaned = text.replace(/```json|```/g, "").trim();
  return JSON.parse(cleaned);
}

async function runSlateQuery(env, params) {
  const url = new URL(env.SLATE_QUERY_URL);
  url.searchParams.set("output", "json");
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value ?? "");
  }
  const resp = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${env.SLATE_TOKEN_MAINDB}` },
  });
  if (!resp.ok) throw new Error(`Slate query failed: ${resp.status}`);
  return resp.json();
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(env) });
    }

    const url = new URL(request.url);

    try {
      if (url.pathname === "/api/options" && request.method === "GET") {
        const forceRefresh = url.searchParams.get("refresh") === "1";
        const options = await getOptions(env, forceRefresh);
        return json(options, env);
      }

      if (url.pathname === "/api/generate" && request.method === "POST") {
        const { prompt } = await request.json();
        if (!prompt) return json({ error: "Missing 'prompt'" }, env, 400);
        const options = await getOptions(env);
        const params = await generateQueryParams(env, prompt, options);
        return json({ params }, env);
      }

      if (url.pathname === "/api/run" && request.method === "POST") {
        const { params } = await request.json();
        if (!params) return json({ error: "Missing 'params'" }, env, 400);
        const data = await runSlateQuery(env, params);
        return json({ data }, env);
      }

      return json({ error: "Not found" }, env, 404);
    } catch (err) {
      return json({ error: err.message }, env, 500);
    }
  },
};