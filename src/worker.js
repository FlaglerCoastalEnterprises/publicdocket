// PublicDocket Worker.
// Static site files in public/ are served by Cloudflare assets. This Worker only
// handles /api/* and a scheduled job. Courthouse docket: we read the Clerk's public
// docket and keep ONLY anonymous counts (no names, no case numbers). Nothing personal
// is ever written to storage or returned to visitors.

const DOCKET = "https://flaglerclerk.gov/docket/";
const UA = "PublicDocket/1.0 (+https://publicdocket.coastalenterprises386.workers.dev/; coastalenterprises386@gmail.com)";

// Step 1 (probe): learn how the Clerk's page loads its list. Stores only URLs,
// sizes and status codes, never page text.
async function probe(env) {
  const out = [];
  const add = (k, v) => out.push([k, String(v).slice(0, 500)]);
  try {
    const r = await fetch(DOCKET, { headers: { "user-agent": UA } });
    const html = await r.text();
    add("page_status", r.status);
    add("page_bytes", html.length);
    add("x_frame_options", r.headers.get("x-frame-options") || "");
    add("csp", (r.headers.get("content-security-policy") || "").slice(0, 400));
    const srcs = [...html.matchAll(/<(?:script|iframe)[^>]+src=["']([^"']+)["']/gi)].map(m => m[1]);
    srcs.forEach(s => add("src", s));
    const urlish = new Set([...html.matchAll(/["'](https?:\/\/[^"'\s]+|\/[^"'\s]*(?:api|ajax|json|docket|calendar|wp-json)[^"'\s]*)["']/gi)].map(m => m[1]));
    [...urlish].slice(0, 60).forEach(u => add("url_in_page", u));
    const forms = [...html.matchAll(/<form[^>]+action=["']([^"']+)["']/gi)].map(m => m[1]);
    forms.forEach(f => add("form", f));
    const ids = [...html.matchAll(/(?:id|class)=["']([^"']*(?:docket|calendar|event|table)[^"']*)["']/gi)].map(m => m[1]);
    [...new Set(ids)].slice(0, 30).forEach(i => add("dom_hint", i));
    add("has_table", /<table/i.test(html));
    add("tr_count", (html.match(/<tr/gi) || []).length);
    // Look inside same-site scripts for data endpoints
    for (const s of srcs.slice(0, 25)) {
      const u = new URL(s, DOCKET);
      if (!/flaglerclerk/i.test(u.hostname) && !/docket|calendar|court/i.test(u.href)) continue;
      try {
        const js = await (await fetch(u.href, { headers: { "user-agent": UA } })).text();
        const eps = new Set([...js.matchAll(/["'`]((?:https?:\/\/|\/)[^"'`\s]*(?:api|ajax|json|docket|calendar|wp-json)[^"'`\s]*)["'`]/gi)].map(m => m[1]));
        [...eps].slice(0, 20).forEach(e => add("endpoint_in_js:" + u.pathname.slice(-60), e));
      } catch (e) { add("js_err", u.href + " " + e.message); }
    }
  } catch (e) { add("error", e.message); }
  const ts = new Date().toISOString();
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS docket_probe (ts TEXT, k TEXT, v TEXT)").run();
  await env.DB.prepare("DELETE FROM docket_probe").run();
  await env.DB.batch(out.map(([k, v]) => env.DB.prepare("INSERT INTO docket_probe VALUES (?,?,?)").bind(ts, k, v)));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/health") return Response.json({ ok: true });
    return env.ASSETS.fetch(request);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(probe(env));
  }
};
