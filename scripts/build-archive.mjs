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
const fmt = s => { if (!s) return ""; const [y, m, d] = s.split("-"); return `${MO[+m - 1]} ${+d}, ${y}`; };
const up = meetings.filter(m => m.date >= today).reverse(), past = meetings.filter(m => m.date < today);
const mrow = m => `<tr data-s="${esc((m.date + " " + fmt(m.date) + " " + m.body + " " + m.title + " " + m.note + " " + m.status).toLowerCase())}">
<td class="nw">${fmt(m.date)}<br><span class="mut">${esc(m.time)}</span></td><td><a href="${esc(m.official_source)}" rel="noopener">${esc(m.body)}</a></td>
<td>${esc(m.title)}${m.note ? `<br><span class="mut">${esc(m.note)}</span>` : ""}</td><td><span class="st st-${m.status === "Confirmed" ? "c" : m.status === "No longer listed" ? "x" : "s"}">${esc(m.status)}</span></td></tr>`;
const table = (rows, cap) => rows.length ? `<div class="tw"><table><caption class="sr">${cap}</caption><thead><tr><th scope="col">Date</th><th scope="col">Body</th><th scope="col">Meeting</th><th scope="col">Status</th></tr></thead><tbody>${rows.map(mrow).join("")}</tbody></table></div>` : `<p class="mut">None yet.</p>`;
const drow = d => `<li data-s="${esc((d.title + " " + d.body + " " + d.summary).toLowerCase())}"><a href="${esc(d.url)}" rel="noopener">${esc(d.title)}</a><span class="mut"> · ${esc(d.body)}${d.date ? " · " + fmt(d.date) : ""} · first indexed ${fmt(d.first_seen)}</span>${d.summary ? `<p>${esc(d.summary)}</p>` : ""}</li>`;
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
<meta name="description" content="Archive of every Flagler County public meeting, agenda and notice PublicDocket has indexed, with links to official sources. Free CSV and JSON downloads.">
<link rel="canonical" href="${SITE}/archive/">
<meta property="og:title" content="Flagler County Public Meetings Archive">
<meta property="og:image" content="${SITE}/logo-full.png">
<script type="application/ld+json">${JSON.stringify(ld)}</script>
<style>
:root{--bg:#f3f8fd;--card:#fff;--fg:#14202e;--muted:#5a6878;--line:#d7e2ee;--brand:#1f5a96;--gold:#a8823c;--navy:#0f2340;--warn:#b06000;--ok:#1e6b3a;--font:Arial,"Helvetica Neue",Helvetica,sans-serif}
@media (prefers-color-scheme:dark){:root{--bg:#14202e;--card:#1d2b3b;--fg:#e8eef5;--muted:#a3b2c2;--line:#30455c;--brand:#8ab4f8;--gold:#d9b56e;--navy:#e8eef5;--warn:#f6ad55;--ok:#7fd19b;color-scheme:dark}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font-family:var(--font);line-height:1.5;font-size:15px}
.wrap{max-width:960px;margin:0 auto;padding-block:32px 56px;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px));display:grid;gap:22px}
a{color:var(--brand)}
.wrap>*{min-width:0}
.logo{display:flex;align-items:center;gap:10px;color:var(--navy);text-decoration:none;font-weight:700;font-size:14px}
.logo img{height:36px;background:#fff;border-radius:8px;padding:3px 5px}
.eyebrow{font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--gold);margin:0}
h1{font-family:Georgia,"Times New Roman",serif;font-size:clamp(28px,6vw,40px);line-height:1.1;margin:0;color:var(--navy);text-wrap:balance}
h2{font-family:Georgia,"Times New Roman",serif;font-size:22px;margin:0 0 10px;color:var(--navy)}
p{margin:0}.lede{color:var(--muted);font-size:16px;max-width:680px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px}
.dl{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px}
.dl div{border:1px solid var(--line);border-radius:10px;padding:12px;display:grid;gap:4px}
.dl b{color:var(--navy)}
input[type=search]{font:inherit;font-size:16px;width:100%;padding:12px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg)}
.tw{overflow-x:auto;border:1px solid var(--line);border-radius:12px;background:var(--card)}
table{border-collapse:collapse;width:100%;min-width:620px}
th,td{text-align:left;vertical-align:top;padding:10px 12px;border-bottom:1px solid var(--line)}
th{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
tr:last-child td{border-bottom:0}
.nw{white-space:nowrap}.mut{color:var(--muted);font-size:13px}
.st{font-size:12px;font-weight:700;white-space:nowrap}.st-c{color:var(--ok)}.st-s{color:var(--muted)}.st-x{color:var(--warn)}
ul.docs{list-style:none;margin:0;padding:0;display:grid;gap:14px}
ul.docs p{font-size:14px;margin-top:2px}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
:focus-visible{outline:2px solid var(--brand);outline-offset:2px}
footer{font-size:13px;color:var(--muted)}
</style>
</head>
<body>
<div class="wrap">
<a class="logo" href="/"><img src="/logo-mark.png" alt="Flagler Coastal Enterprises logo"><span>PublicDocket · by Flagler Coastal Enterprises</span></a>
<div><p class="eyebrow">Public archive</p><h1>Flagler County meetings and documents archive</h1></div>
<p class="lede">Every meeting, agenda and notice PublicDocket has indexed from official Flagler County government websites, including past items that no longer appear in search. Each entry links to the official source, which is the legal record. Updated ${fmt(today)}.</p>
<section class="card" aria-labelledby="dlh"><h2 id="dlh">Download the data</h2>
<p class="mut" style="margin-bottom:10px">Free to use with credit to PublicDocket. Spreadsheet (CSV) files open in Excel or Google Sheets.</p>
<div class="dl">
<div><b>Meetings</b><span class="mut">${meetings.length} records</span><span><a href="/data/meetings.csv">CSV</a> · <a href="/data/meetings.json">JSON</a></span></div>
<div><b>Documents</b><span class="mut">${documents.length} records</span><span><a href="/data/documents.csv">CSV</a> · <a href="/data/documents.json">JSON</a></span></div>
<div><b>Government bodies</b><span class="mut">${bodyList.length} records</span><span><a href="/data/bodies.csv">CSV</a> · <a href="/data/bodies.json">JSON</a></span></div>
</div></section>
<label class="sr" for="flt">Filter the archive</label>
<input id="flt" type="search" placeholder="Filter by body, date or topic (e.g. Bunnell, November, landfill)" autocomplete="off">
<section aria-labelledby="uph"><h2 id="uph">Upcoming meetings</h2>${table(up, "Upcoming meetings")}</section>
<section aria-labelledby="pah"><h2 id="pah">Past meetings</h2>${table(past, "Past meetings")}</section>
<section aria-labelledby="doh"><h2 id="doh">Agendas, notices and documents</h2><ul class="docs">${documents.map(drow).join("")}</ul></section>
<section aria-labelledby="boh"><h2 id="boh">Government bodies covered</h2><ul class="docs">${bodyList.map(b => `<li><a href="${esc(b.official_site)}" rel="noopener">${esc(b.name)}</a><p>${esc(b.schedule)}${b.location ? " · " + esc(b.location) : ""}</p></li>`).join("")}</ul></section>
<footer><p>"Confirmed" means an official source listed the meeting. "On regular schedule" means it follows the body's normal calendar but wasn't individually confirmed. "No longer listed" means it was removed before its date, often because it was rescheduled or canceled. Spot an error? Email <a href="mailto:coastalenterprises386@gmail.com">coastalenterprises386@gmail.com</a>.</p>
<p style="margin-top:8px"><a href="/">Search PublicDocket</a> · <a href="/subscribe/">Weekly digest</a> · <a href="https://x.com/FCEpublicdocket" rel="noopener me">Follow on X</a></p></footer>
</div>
<script>
const f=document.getElementById("flt"),rows=[...document.querySelectorAll("[data-s]")];
f.addEventListener("input",()=>{const q=f.value.trim().toLowerCase().split(/\\s+/).filter(Boolean);rows.forEach(r=>{r.hidden=q.length&&!q.every(w=>r.dataset.s.includes(w))})});
</script>
</body>
</html>
`;
writeFileSync("public/archive/index.html", page);
console.log(`archive: ${meetings.length} meetings (${up.length} upcoming, ${past.length} past), ${documents.length} documents, ${bodyList.length} bodies`);
