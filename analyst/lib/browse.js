// browse.js — the browser fallback for firms my slug-guesser couldn't resolve. Drives
// playwright-cli to run a search, then mines the results for the firm's *real* ATS slug
// (the highest-value find: it hands the firm straight back to the free ATS-JSON path)
// or, failing that, a careers page to scrape. Search engines fight bots, so every step
// degrades to null rather than throwing — an unresolved firm stays honestly unresolved.
const pw = require("./pw");
const sniff = require("./sniff");

// Pull decoded result URLs off a Bing results page already loaded in `session`.
// (Bing lets an automated browser through; DuckDuckGo's HTML endpoint bot-walls it.)
// Bing wraps some links in /ck/a?...&u=a1<base64url>; we decode those to the real target
// and drop Bing/Microsoft nav chrome so only genuine results remain.
function resultLinks(session) {
  const fn =
    "() => {" +
    "const b64=(s)=>{try{return decodeURIComponent(escape(atob(s.replace(/-/g,'+').replace(/_/g,'/'))))}catch(e){return ''}};" +
    "const dec=(h)=>{try{const u=new URL(h,location.href);" +
    "if(/bing\\.com$/i.test(u.hostname)&&u.pathname.indexOf('/ck/')===0){let x=(u.searchParams.get('u')||'').replace(/^a1/,'');return b64(x)||h;}" +
    "const t=u.searchParams.get('uddg');return t?decodeURIComponent(t):h;}catch(e){return h;}};" +
    "const scope=document.querySelector('#b_results')||document.body;" +
    "return [...scope.querySelectorAll('a[href]')].map(a=>dec(a.href))" +
    ".filter(h=>/^https?:/i.test(h)&&!/\\/\\/([a-z0-9-]+\\.)*(bing|microsoft|msn)\\.com/i.test(h))" +
    ".filter((v,i,s)=>s.indexOf(v)===i).slice(0,60);}";
  return pw.evalJson(session, fn) || [];
}

// Detect a known ATS host + slug from a list of URLs. Order matters: check the path
// forms before the bare-subdomain greenhouse form so we don't grab "boards" as a slug.
function detectAts(links) {
  for (const url of links) {
    let m;
    if ((m = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)/i))) return { provider: "ashby", slug: m[1] };
    if ((m = url.match(/(?:boards|job-boards)\.greenhouse\.io\/(?:embed\/job_board\?for=)?([^/?#&]+)/i)))
      return { provider: "greenhouse", slug: m[1] };
    if ((m = url.match(/jobs\.lever\.co\/([^/?#]+)/i))) return { provider: "lever", slug: m[1] };
    if ((m = url.match(/^https?:\/\/([a-z0-9-]+)\.greenhouse\.io/i)) && m[1] !== "boards" && m[1] !== "job-boards")
      return { provider: "greenhouse", slug: m[1] };
    // Workday-hosted boards: https://{tenant}.{wdN}.myworkdayjobs.com/{en-US/}{site}/...
    // Frequently the REAL backend behind a company's own branded careers page (e.g.
    // PNC's careers.pnc.com is a skin over pnc.wd5.myworkdayjobs.com/External) — this
    // link only ever shows up once a page is rendered and its real job links appear,
    // which is exactly what this pageProbe/search-result scan is looking at. slug is
    // a compound "tenant|wdHost|site" string — see ats.js's workday() adapter.
    if ((m = url.match(/^https?:\/\/([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([^/?#]+)/i)))
      return { provider: "workday", slug: `${m[1]}|${m[2]}|${m[3]}` };
    // Jobvite: https://jobs.jobvite.com/{company-slug}[/job/{id}|/apply|...] — slug is
    // the first path segment, whether the link points at the board root or a single
    // job (search results usually land on one specific /job/{id} page — the slug still
    // recovers the WHOLE board via ats.js's jobvite() adapter, not just that one posting).
    if ((m = url.match(/^https?:\/\/jobs\.jobvite\.com\/([a-z0-9-]+)(?:[/?#]|$)/i)))
      return { provider: "jobvite", slug: m[1] };
    // Workable: https://apply.workable.com/{account}/... — public JSON widget API,
    // see ats.js's workable() adapter (verified live against 4 real accounts).
    if ((m = url.match(/^https?:\/\/apply\.workable\.com\/([a-z0-9-]+)(?:[/?#]|$)/i)))
      return { provider: "workable", slug: m[1] };
    // SmartRecruiters: jobs.smartrecruiters.com/{slug}/... or careers.smartrecruiters.com/{slug}
    // — see ats.js's smartrecruiters() adapter (verified live, 193 real postings).
    if ((m = url.match(/^https?:\/\/(?:jobs|careers)\.smartrecruiters\.com\/([a-zA-Z0-9-]+)(?:[/?#]|$)/i)))
      return { provider: "smartrecruiters", slug: m[1] };
  }
  return null;
}

// Pick the most plausible careers/job page from the results when no ATS slug was found.
function pickCareersUrl(links, company) {
  const token = (company || "").toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 6);
  const scored = links
    .map((u) => {
      let s = 0;
      if (/careers?|jobs?|/.test(u) && /(careers?|jobs?)/i.test(u)) s += 2;
      if (token && u.toLowerCase().includes(token)) s += 3;
      if (/greenhouse|ashby|lever|workday|icims|myworkdayjobs|jobvite/i.test(u)) s += 2;
      if (/glassdoor|indeed|linkedin|ziprecruiter|wikipedia/i.test(u)) s -= 5; // aggregators, not the source
      return { u, s };
    })
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);
  return scored.length ? scored[0].u : null;
}

// All http links on the page currently loaded in `session`.
function pageLinks(session) {
  return (
    pw.evalJson(
      session,
      "() => [...document.querySelectorAll('a[href]')].map(a=>a.href).filter(h=>/^https?:/i.test(h)).filter((v,i,s)=>s.indexOf(v)===i).slice(0,150)"
    ) || []
  );
}

// Combined single-round-trip probe of the page currently loaded in `session`: page
// links (for ATS-slug detection) AND whether a JSON-LD JobPosting is present, in one
// page.evaluate/CLI call instead of two. Each pw call is a separate `playwright-cli`
// subprocess spawn, so this halves the per-URL cost of the findFirm loop.
function pageProbe(session) {
  const fn =
    "() => {" +
    "const links=[...document.querySelectorAll('a[href]')].map(a=>a.href).filter(h=>/^https?:/i.test(h)).filter((v,i,s)=>s.indexOf(v)===i).slice(0,150);" +
    "const hasJobPosting=[...document.querySelectorAll('script[type=\"application/ld+json\"]')].map(x=>{try{return JSON.parse(x.textContent)}catch(e){return null}}).flatMap(v=>Array.isArray(v)?v:[v]).some(x=>x&&x['@type']==='JobPosting');" +
    // Jibe (SAP SuccessFactors Recruiting Marketing) job-search widget: a client-
    // rendered Angular app loaded from app.jibecdn.com, same-origin JSON API at
    // /api/jobs on whatever domain it's embedded on (see ats.js's jibe() adapter —
    // verified live against careers.amd.com). No <a href> link to the CDN bundle
    // necessarily exists, so check the script src directly instead of relying on
    // detectAts()'s link-scan.
    "const hasJibe=[...document.querySelectorAll('script[src]')].some(s=>/app\\.jibecdn\\.com/i.test(s.src));" +
    "return {links, hasJobPosting, hasJibe};}";
  return pw.evalJson(session, fn) || { links: [], hasJobPosting: false, hasJibe: false };
}

// Guess a firm's own careers-page URLs from its display name. Search-free (search
// engines bot-wall headless browsers), so this is the primary discovery path: a
// company's careers page very often links straight to its ATS board.
function guessCareersUrls(company) {
  const base = (company || "")
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((w) => !["the", "inc", "llc", "lp", "group", "company", "co", "capital", "partners", "management", "and"].includes(w));
  const slugs = [...new Set([base.join(""), base.join("-"), base[0]].filter(Boolean))];
  const urls = [];
  for (const s of slugs.slice(0, 2)) {
    urls.push(`https://www.${s}.com/careers`, `https://${s}.com/careers`, `https://careers.${s}.com`);
  }
  return urls;
}

// The registrable domain (last two labels) — good enough to tell "careers.microsoft.com"
// and "apply.careers.microsoft.com" are the same company's site without a full public-
// suffix-list dependency. Doesn't handle multi-part TLDs (co.uk) precisely, but this is
// a same-company heuristic, not a security boundary — a false-positive match just means
// trying one extra page that turns out irrelevant.
function baseDomain(hostname) {
  const parts = hostname.split(".");
  return parts.length > 2 ? parts.slice(-2).join(".") : hostname;
}

// A landing/marketing careers page (e.g. Microsoft's "university internship" overview)
// often doesn't itself fire the job-search API — a deeper "search/apply" page does, and
// it's often on a DIFFERENT subdomain (Microsoft's is apply.careers.microsoft.com, not
// careers.microsoft.com — verified live 2026-08-06). Pick a same-company link that looks
// like that deeper page, so findFirm can follow it once (mimicking a human clicking
// "Search jobs" / "Apply now") instead of giving up.
function pickJobsSearchLink(links, currentUrl) {
  let site;
  try { site = baseDomain(new URL(currentUrl).hostname); } catch (_) { return null; }
  const scored = links
    .filter((u) => { try { return baseDomain(new URL(u).hostname) === site; } catch (_) { return false; } })
    .map((u) => {
      let s = 0;
      if (/\/search\b|\/jobs?\b|\/openings?\b|\/opportunit|\/listings?\b|\/positions?\b|\/apply\b|\/join\b/i.test(u)) s += 3;
      if (/careers?/i.test(u)) s += 1;
      return { u, s };
    })
    .filter((x) => x.s > 0 && x.u !== currentUrl)
    .sort((a, b) => b.s - a.s);
  return scored.length ? scored[0].u : null;
}

// Try one page: ATS-link, single-JobPosting, then a shape-based network sniff. Returns
// the same {provider,slug} / {careersUrl} / {sniffed} shapes findFirm returns, or null.
function probePage(session, url) {
  const r = pw.goto(session, url);
  if (r.code !== 0) return null;
  const { links, hasJobPosting, hasJibe } = pageProbe(session);
  if (!links.length && !hasJobPosting && !hasJibe) return null;
  const ats = detectAts(links);
  if (ats) return ats;
  if (hasJibe) { try { return { provider: "jibe", slug: new URL(url).hostname }; } catch (_) {} }
  if (hasJobPosting) return { careersUrl: url };
  const sniffed = sniff.sniffJobsApi(session);
  if (sniffed) return { sniffed, sniffedUrl: url }; // sniffedUrl: where it worked, so the
  // caller can remember this page for next time (lib/registry.js) instead of re-guessing.
  return { links }; // nothing found directly, but hand back links for the one-hop follow
}

// One browser pass for a firm. Tries hintUrl first (a careers URL the search pass
// already found — no guessing needed), then the firm's own guessed careers page(s),
// then a web search as a last resort (often bot-walled). Returns {provider, slug}
// (preferred — reuse ATS JSON), {careersUrl} to scrape, {sniffed: postings[]} (a
// bespoke portal whose own JSON API we mined directly — see sniff.js), or null.
function findFirm(session, company, queryHint, hintUrl) {
  const urlsToTry = hintUrl ? [hintUrl, ...guessCareersUrls(company)] : guessCareersUrls(company);
  for (const url of urlsToTry) {
    const hit = probePage(session, url);
    if (!hit) continue;
    if (hit.slug || hit.careersUrl || hit.sniffed) return hit;
    // Landing page had real content but nothing usable directly — try ONE same-site
    // "search jobs"-looking link before moving to the next guessed URL (bounded: a
    // single extra hop, not a crawl).
    const deeper = pickJobsSearchLink(hit.links, url);
    if (deeper) {
      const hit2 = probePage(session, deeper);
      if (hit2 && (hit2.slug || hit2.careersUrl || hit2.sniffed)) return hit2;
    }
  }
  // Last resort: web search (best-effort; frequently returns nothing headless).
  // queryHint narrows intent per tab, e.g. "Hong Kong" (china_hk), "off-cycle fall 2026"
  // (fall2026/spring2027), "part-time teller" (ithaca) — appended to the base query.
  const q = encodeURIComponent(`${company} careers internship finance${queryHint ? " " + queryHint : ""}`);
  if (pw.goto(session, `https://www.bing.com/search?q=${q}`).code === 0) {
    const links = resultLinks(session);
    const ats = detectAts(links);
    if (ats) return ats;
    const careersUrl = pickCareersUrl(links, company);
    if (careersUrl) return { careersUrl };
  }
  return null;
}

module.exports = { findFirm, guessCareersUrls, detectAts, pickCareersUrl, resultLinks, pageLinks, pageProbe };
