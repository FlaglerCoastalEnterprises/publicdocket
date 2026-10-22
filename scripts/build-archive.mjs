// Builds the public archive from every version of public/index.html in git history
// plus the current working copy. No dependencies. Run from the repo root:
//   node scripts/build-archive.mjs
// Writes: public/archive/index.html, public/data/{meetings,documents,bodies}.{json,csv}
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import vm from "node:vm";

const SITE = "https://publicdocket.coastalenterprises386.workers.dev";
const ST = { c: "Confirmed", s: "On regular schedule", w: "Date may change", x: "No longer listed" };
const sh = c => execSync(c, { encoding: "utf8", maxBuffer: 64 << 20 });

function extract(html) {
  const a = html.indexOf("const BODY="), b = html.indexOf("const MO=");
  if (a < 0 || b < 0) return null;
  const ctx = {};
  try { vm.runInNewContext(html.slice(a, b).replace(/^const /gm, "var ") , ctx, { timeout: 2000 }); }
  catch { return null; }
  return { BODY: ctx.BODY || {}, MEET: ctx.MEET || [], DOCS: ctx.DOCS || [] };
}

// Oldest first, then the working copy as "today".
const commits = sh("git log --reverse '--format=%H|%cs' -- public/index.html").trim().split("\n").filter(Boolean)
  .map(l => { const [h, d] = l.split("|"); return { h, d }; });
const today = new Date().toISOString().slice(0, 10);
const versions = commits.map(c => ({ d: c.d, html: sh(`git show ${c.h}:public/index.html`) }));
versions.push({ d: today, html: readFileSync("public/index.html", "utf8") });

const meets = new Map(), docs = new Map(), bodies = {};
let current = null;
for (const v of versions) {
  const x = extract(v.html); if (!x) continue;
  current = x;
  Object.assign(bodies, x.BODY);
  for (const m of x.MEET) {
    const [date, time, b, title, place, status, note] = m;
    const k = `${date}|${time}|${b}`;
    const prev = meets.get(k);
    meets.set(k, { date, time, body_key: b, title, place: place || "", status, note: note || "", first_seen: prev ? prev.first_seen : v.d, last_seen: v.d });
  }
  for (const d of x.DOCS) {
    const k = d.url + "|" + (d.date || "");
    const prev = docs.get(k);
    docs.set(k, { date: d.date || "", body_key: d.b, title: d.title, url: d.url, summary: d.snip || "", first_seen: prev ? prev.first_seen : v.d, last_seen: v.d });
  }
}
// Items dropped from the site before their date happened (rescheduled, canceled or corrected).
const curKeys = new Set(current.MEET.map(m => `${m[0]}|${m[1]}|${m[2]}`));
for (const [k, m] of meets) if (!curKeys.has(k) && m.date > m.last_seen) m.status = "x";
const curDocs = new Set(current.DOCS.map(d => d.url + "|" + (d.date || "")));

const B = k => bodies[k] || { name: k, short: k, url: "" };
const meetings = [...meets.values()].map(m => ({
  date: m.date, time: m.time, body: B(m.body_key).name, body_key: m.body_key, title: m.title,
  status: ST[m.status] || m.status, note: m.note, official_source: B(m.body_key).url,
  first_seen: m.first_seen, last_seen: m.last_seen
})).sort((a, b) => a.date < b.date ? 1 : a.date > b.date ? -1 : a.body.localeCompare(b.body));
const documents = [...docs.entries()].map(([k, d]) => ({
  date: d.date, body: B(d.body_key).name, body_key: d.body_key, title: d.title, url: d.url, summary: d.summary,
  first_seen: d.first_seen, last_seen: curDocs.has(k) ? today : d.last_seen
})).sort((a, b) => (b.date || b.first_seen).localeCompare(a.date || a.first_seen));
const bodyList = Object.entries(bodies).map(([k, b]) => ({ key: k, name: b.name, type: b.type, schedule: b.sched, location: b.where, official_site: b.url, phone: b.phone || "" }));

// ---------- data files ----------
mkdirSync("public/data", { recursive: true });
mkdirSync("public/archive", { recursive: true });
const csv = rows => { const cols = Object.keys(rows[0] || {}); const q = v => { v = String(v ?? ""); return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; };
  return [cols.join(","), ...rows.map(r => cols.map(c => q(r[c])).join(","))].join("\n") + "\n"; };
const meta = { publisher: "PublicDocket by Flagler Coastal Enterprises LLC", generated: today, license: "Public government information. Summaries by PublicDocket; free to reuse with credit.", note: "Links point to the official government record, which governs. 'No longer listed' means the item was removed before its date (often rescheduled or canceled)." };
for (const [n, rows] of [["meetings", meetings], ["documents", documents], ["bodies", bodyList]]) {
  writeFileSync(`public/data/${n}.json`, JSON.stringify({ ...meta, count: rows.length, [n]: rows }, null, 1) + "\n");
  writeFileSync(`public/data/${n}.csv`, csv(rows));
}

// ---------- archive page ----------
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const MO = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const fmt = s => { if (!s) return ""; const [y, m, d] = s.split("-"); return `${MO[+m - 1]} ${+d}, ${y}`; };
const wd = s => WD[new Date(s + "T12:00:00Z").getUTCDay()];
const up = meetings.filter(m => m.date >= today).reverse(), past = meetings.filter(m => m.date < today);

// Editorial highlights: the homepage "Coming up" headlines (current version only).
let HEAD = [];
{ const html = versions[versions.length - 1].html, a = html.indexOf("const HEAD="), b = a < 0 ? -1 : html.indexOf("\n];", a);
  if (a >= 0 && b > a) { const ctx = {}; try { vm.runInNewContext("var " + html.slice(a + 6, b + 3), ctx, { timeout: 2000 }); HEAD = ctx.HEAD || []; } catch {} } }
const hl = HEAD.filter(h => h.d >= today).sort((a, b) => a.d < b.d ? -1 : 1).sort((a, b) => (b.tag === "Hearing") - (a.tag === "Hearing")).slice(0, 4);
const recentDocs = documents.filter(d => d.date).slice(0, 3);
const shortName = k => (bodies[k] && bodies[k].short) || B(k).name;

const card = h => `<a class="hc" href="/?q=${encodeURIComponent(h.q || "")}"><span class="dd"><small>${MO[+h.d.slice(5, 7) - 1]}</small><b>${+h.d.slice(8, 10)}</b><small>${wd(h.d)}</small></span>
<span class="tx"><span class="src">${esc(shortName(h.b))}${h.tag ? ` · <em>${esc(h.tag)}</em>` : ""}</span><strong>${esc(h.t)}</strong><span class="mut">${esc(h.w)}</span></span></a>`;
const mrow = m => `<tr data-s="${esc((m.date + " " + fmt(m.date) + " " + m.body + " " + m.title + " " + m.note + " " + m.status).toLowerCase())}">
<td class="nw">${fmt(m.date)}<br><span class="mut">${esc(m.time)}</span></td><td><a href="${esc(m.official_source)}" rel="noopener">${esc(m.body)}</a></td>
<td>${esc(m.title)}${m.note ? `<br><span class="mut">${esc(m.note)}</span>` : ""}</td><td><span class="st st-${m.status === "Confirmed" ? "c" : m.status === "No longer listed" ? "x" : "s"}">${esc(m.status)}</span></td></tr>`;
const table = (rows, cap) => rows.length ? `<div class="tw"><table><caption class="sr">${cap}</caption><thead><tr><th scope="col">Date</th><th scope="col">Body</th><th scope="col">Meeting</th><th scope="col">Status</th></tr></thead><tbody>${rows.map(mrow).join("")}</tbody></table></div>` : `<p class="mut">None yet. Meetings move here after they happen.</p>`;
const drow = d => `<li data-s="${esc((d.title + " " + d.body + " " + d.summary).toLowerCase())}"><a href="${esc(d.url)}" rel="noopener">${esc(d.title)}</a><span class="mut"> · ${esc(d.body)}${d.date ? " · " + fmt(d.date) : ""}</span>${d.summary ? `<p>${esc(d.summary)}</p>` : ""}</li>`;
const ld = { "@context": "https://schema.org", "@type": "Dataset", name: "PublicDocket Flagler meetings and documents archive",
  description: "Every Flagler County, Florida public meeting, agenda and notice indexed by PublicDocket, with links to the official government sources: Flagler County Commission, Palm Coast City Council, Flagler Beach City Commission, Bunnell City Commission and Flagler County School Board.",
  url: SITE + "/archive/", isAccessibleForFree: true, dateModified: today, spatialCoverage: "Flagler County, Florida",
  creator: { "@type": "Organization", name: "Flagler Coastal Enterprises LLC", url: SITE + "/" },
  distribution: ["meetings", "documents", "bodies"].flatMap(n => [{ "@type": "DataDownload", encodingFormat: "application/json", contentUrl: `${SITE}/data/${n}.json` }, { "@type": "DataDownload", encodingFormat: "text/csv", contentUrl: `${SITE}/data/${n}.csv` }]) };

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Flagler County Public Meetings Archive | PublicDocket</title>
<meta name="description" content="Highlights and full archive of Flagler County public meetings, agendas and notices indexed by PublicDocket, with links to official sources. Free CSV and JSON downloads.">
<link rel="canonical" href="${SITE}/archive/">
<meta property="og:title" content="Flagler County Public Meetings Archive">
<meta property="og:image" content="${SITE}/logo-full.png">
<script type="application/ld+json">${JSON.stringify(ld)}</script>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Nunito+Sans:opsz,wght@6..12,400;6..12,700;6..12,800&display=swap" rel="stylesheet">
<style>
:root{--bg:#f6fbf9;--card:#fff;--fg:#1b2e2b;--muted:#536b66;--line:#d3e5e0;--brand:#1a7d71;--on-brand:#fff;--gold:#a8823c;--navy:#173f3a;--warn:#a65a00;--ok:#1e6b3a;--soft:#e9f5f1;--font:"Nunito Sans",system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}
@media (prefers-color-scheme:dark){:root{--bg:#0f1b1a;--card:#152522;--fg:#e2f1ed;--muted:#9bb7b1;--line:#2a3f3c;--brand:#5cc7b2;--on-brand:#0f1b1a;--gold:#d9b56e;--navy:#e2f1ed;--warn:#f2b266;--ok:#7fd19b;--soft:#172826;color-scheme:dark}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font-family:var(--font);line-height:1.5;font-size:15px}
.wrap{max-width:860px;margin:0 auto;padding-block:28px 56px;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px));display:grid;gap:28px}
.wrap>*{min-width:0}
a{color:var(--brand)}
.logo{display:flex;align-items:center;gap:10px;color:var(--navy);text-decoration:none;font-weight:700;font-size:14px}
.logo img{height:36px;background:#fff;border-radius:8px;padding:3px 5px}
.eyebrow{font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--gold);margin:0 0 6px}
h1{font-family:Georgia,"Times New Roman",serif;font-size:clamp(28px,6vw,38px);line-height:1.1;margin:0;color:var(--navy);text-wrap:balance}
h2{font-family:Georgia,"Times New Roman",serif;font-size:21px;margin:0 0 12px;color:var(--navy)}
p{margin:0}.lede{color:var(--muted);font-size:16px;margin-top:8px;max-width:620px}
.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}
.stats div{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px;text-align:center}
.stats b{display:block;font-size:24px;color:var(--navy);font-family:Georgia,serif}
.stats span{font-size:12px;color:var(--muted)}
@media (max-width:520px){.stats{grid-template-columns:repeat(2,minmax(0,1fr))}}
.hgrid{display:grid;gap:10px}
.hc{display:flex;gap:14px;align-items:flex-start;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;text-decoration:none;color:var(--fg)}
.hc:hover{border-color:var(--brand)}
.dd{flex:none;width:52px;text-align:center;border-right:1px solid var(--line);padding-right:12px;display:grid}
.dd b{font-size:24px;line-height:1.1;color:var(--gold);font-family:Georgia,serif}
.dd small{font-size:11px;text-transform:uppercase;color:var(--muted);letter-spacing:.05em}
.tx{display:grid;gap:2px}.tx strong{color:var(--brand);font-size:16px;line-height:1.3}
.src{font-size:12px;color:var(--muted)}.src em{font-style:normal;font-weight:700;color:var(--warn)}
.mut{color:var(--muted);font-size:13px}
ul.docs{list-style:none;margin:0;padding:0;display:grid;gap:14px}
ul.docs p{font-size:14px;margin-top:2px}
.recent li{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px}
.full{display:grid;gap:10px}
.full>*{min-width:0}
details{background:var(--card);border:1px solid var(--line);border-radius:12px}
summary{cursor:pointer;padding:14px 16px;font-weight:700;color:var(--navy);list-style:none;display:flex;justify-content:space-between;gap:10px}
summary::-webkit-details-marker{display:none}
summary::after{content:"+";color:var(--muted);font-weight:400;font-size:18px;line-height:1}
details[open] summary::after{content:"–"}
summary .mut{font-weight:400;margin-left:auto}
.inner{padding:0 16px 16px}
input[type=search]{font:inherit;font-size:16px;width:100%;padding:12px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg)}
.tw{overflow-x:auto;border:1px solid var(--line);border-radius:10px}
table{border-collapse:collapse;width:100%;min-width:600px}
th,td{text-align:left;vertical-align:top;padding:10px 12px;border-bottom:1px solid var(--line)}
th{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
tr:last-child td{border-bottom:0}
.nw{white-space:nowrap}
.st{font-size:12px;font-weight:700;white-space:nowrap}.st-c{color:var(--ok)}.st-s{color:var(--muted)}.st-x{color:var(--warn)}
.dl{font-size:14px;color:var(--muted);background:var(--soft);border-radius:12px;padding:14px 16px}
.dl b{color:var(--navy)}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
:focus-visible{outline:2px solid var(--brand);outline-offset:2px}
footer{font-size:13px;color:var(--muted)}
h1,h2,.stats b{font-family:"Nunito Sans",system-ui,sans-serif!important;font-weight:800}
</style>
</head>
<body>
<div class="wrap">
<a class="logo" href="/"><img src="/logo-mark.png" alt="Flagler Coastal Enterprises logo"><span>PublicDocket · by Flagler Coastal Enterprises</span></a>
<header><p class="eyebrow">Archive · Updated ${fmt(today)}</p><h1>Flagler County public meetings at a glance</h1>
<p class="lede">The highlights first. Every record we've collected is below, each linked to the official government source.</p></header>
<div class="stats" aria-label="Archive totals">
<div><b>${up.length}</b><span>upcoming meetings</span></div><div><b>${past.length}</b><span>past meetings</span></div><div><b>${documents.length}</b><span>documents</span></div><div><b>${Object.values(current.BODY).filter(b => !b.rec).length}</b><span>boards covered</span></div>
</div>
${hl.length ? `<section aria-labelledby="hlh"><h2 id="hlh">Highlights</h2><div class="hgrid">${hl.map(card).join("")}</div></section>` : ""}
${recentDocs.length ? `<section aria-labelledby="rdh"><h2 id="rdh">Recently posted</h2><ul class="docs recent">${recentDocs.map(drow).join("")}</ul></section>` : ""}
<section class="full" aria-labelledby="fullh"><h2 id="fullh">Full records</h2>
<label class="sr" for="flt">Search the full records</label>
<input id="flt" type="search" placeholder="Search all records (e.g. Bunnell, November, landfill)" autocomplete="off">
<details><summary>Upcoming meetings <span class="mut">${up.length}</span></summary><div class="inner">${table(up, "Upcoming meetings")}</div></details>
<details><summary>Past meetings <span class="mut">${past.length}</span></summary><div class="inner">${table(past, "Past meetings")}</div></details>
<details><summary>Agendas, notices and documents <span class="mut">${documents.length}</span></summary><div class="inner"><ul class="docs">${documents.map(drow).join("")}</ul></div></details>
<details><summary>Boards covered <span class="mut">${bodyList.length}</span></summary><div class="inner"><ul class="docs">${bodyList.map(b => `<li><a href="${esc(b.official_site)}" rel="noopener">${esc(b.name)}</a><p>${esc(b.schedule)}${b.location ? " · " + esc(b.location) : ""}</p></li>`).join("")}</ul></div></details>
</section>
<p class="dl"><b>Download the data:</b> meetings (<a href="/data/meetings.csv">CSV</a>, <a href="/data/meetings.json">JSON</a>) · documents (<a href="/data/documents.csv">CSV</a>, <a href="/data/documents.json">JSON</a>) · boards (<a href="/data/bodies.csv">CSV</a>, <a href="/data/bodies.json">JSON</a>). Free to use with credit to PublicDocket. CSV files open in Excel or Google Sheets.</p>
<footer><p>"Confirmed" means an official source listed the meeting. "On regular schedule" means it follows the board's normal calendar but wasn't individually confirmed. "No longer listed" means it was removed before its date, often because it was rescheduled or canceled. Spot an error? Email <a href="mailto:coastalenterprises386@gmail.com">coastalenterprises386@gmail.com</a>.</p>
<p style="margin-top:8px"><a href="/">Search PublicDocket</a> · <a href="/subscribe/">Weekly digest</a> · <a href="https://x.com/FCEpublicdocket" rel="noopener me">Follow on X</a></p></footer>
</div>
<script>
const f=document.getElementById("flt"),rows=[...document.querySelectorAll(".full [data-s]")],ds=[...document.querySelectorAll(".full details")];
f.addEventListener("input",()=>{const q=f.value.trim().toLowerCase().split(/\\s+/).filter(Boolean);
rows.forEach(r=>{r.hidden=q.length&&!q.every(w=>r.dataset.s.includes(w))});
if(q.length)ds.forEach(d=>{d.open=!!d.querySelector("[data-s]:not([hidden])")})});
</script>
</body>
</html>
`;
writeFileSync("public/archive/index.html", page);
console.log(`archive: ${meetings.length} meetings (${up.length} upcoming, ${past.length} past), ${documents.length} documents, ${bodyList.length} bodies, ${hl.length} highlights`);
