// ats.js — the deterministic majority path. Most employers post through a handful
// of ATS platforms that expose public JSON job-board endpoints. Presence of a
// requisition on the live board is itself positive evidence it's open — so for the
// ATS-covered slice we get open/closed for FREE, no browser and no model.
//
// Slug guessing: from a company display name we try a few normalized slugs against
// each provider. A hit returns normalized postings; misses fall through to the
// browser/search path in run-analyst.js.

// getJson/postJson route through lib/http.js — Node's classic http(s) client, NOT
// fetch()/undici, which has a real connection-pool bug under this app's concurrency
// (see lib/http.js for the full writeup and the GitHub issues).
const { rawJson, rawRequest } = require("./http");

function slugs(name) {
  const base = name
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")            // drop parentheticals like "(Sustainable Investing)"
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const noStop = base
    .split(" ")
    .filter((w) => !["the", "inc", "llc", "lp", "group", "company", "co", "capital", "partners", "management"].includes(w));
  const joined = noStop.join("");
  const hyphen = noStop.join("-");
  const first = noStop[0] || joined;
  return [...new Set([joined, hyphen, first].filter(Boolean))];
}

async function getJson(url, timeoutMs = 15000) {
  return rawJson(url, { headers: { accept: "application/json" }, timeoutMs });
}

// --- Provider adapters: each returns [{title, apply_url, location, open:true, source}] or null ---

async function ashby(slug) {
  const data = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=false`);
  if (!data || !Array.isArray(data.jobs)) return null;
  return data.jobs
    .filter((j) => j.isListed !== false)
    .map((j) => ({
      title: j.title,
      apply_url: j.jobUrl || j.applyUrl || "",
      location: j.location || (j.address && j.address.postalAddress && j.address.postalAddress.addressLocality) || "",
      open: true,
      source: "ashby",
    }));
}

async function greenhouse(slug) {
  const data = await getJson(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`);
  if (!data || !Array.isArray(data.jobs)) return null;
  return data.jobs.map((j) => ({
    title: j.title,
    apply_url: j.absolute_url || "",
    location: (j.location && j.location.name) || "",
    open: true,
    source: "greenhouse",
  }));
}

async function lever(slug) {
  const data = await getJson(`https://api.lever.co/v0/postings/${slug}?mode=json`);
  if (!Array.isArray(data)) return null;
  return data.map((j) => ({
    title: j.text,
    apply_url: j.hostedUrl || j.applyUrl || "",
    location: (j.categories && j.categories.location) || "",
    open: true,
    source: "lever",
  }));
}

async function postJson(url, body, timeoutMs = 15000) {
  return rawJson(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", accept: "application/json" },
    body,
    timeoutMs,
  });
}

// Workday CXS (Candidate Experience Service) — the public JSON API behind every
// Workday-hosted career site (https://{tenant}.{wdN}.myworkdayjobs.com/{site}). Many
// large employers (banks especially) run on Workday but front it with their own
// branded careers page (e.g. PNC's careers.pnc.com is a Phenom People skin over a
// pnc.wd5.myworkdayjobs.com/External board) — invisible to a name-guess, only found
// once something (search results or a rendered page's real links) surfaces the
// myworkdayjobs.com URL. Unlike ashby/greenhouse/lever, tenant+wdN+site can't be
// guessed from a company name, so this is NOT in the guess-by-name PROVIDERS list —
// it's reachable only via a discovered slug (see detectAts() in lib/browse.js, which
// builds the compound "tenant|wdHost|site" slug this adapter expects).
// Workday's CXS API 400s above limit=20 (measured live against PNC's board — limit=25
// already fails) despite the endpoint accepting arbitrary offsets, so pagination has
// to go 20 at a time.
const WORKDAY_PAGE_SIZE = 20;
const WORKDAY_MAX_POSTINGS = 500; // cap request count (25 calls) for mega-boards; classify.js title-filters the rest anyway

async function workday(slug) {
  const [tenant, wdHost, site] = String(slug).split("|");
  if (!tenant || !wdHost || !site) return null;
  const base = `https://${tenant}.${wdHost}.myworkdayjobs.com`;
  const api = `${base}/wday/cxs/${tenant}/${site}/jobs`;
  const out = [];
  let offset = 0;
  let total = Infinity; // Workday only reports a real `total` on the FIRST page — every
  // later page reports total:0, so this must be captured ONCE, not reassigned per page
  // (reassigning made the loop stop after page 2 every time — found live against PNC).
  let totalKnown = false;
  while (offset < total && offset < WORKDAY_MAX_POSTINGS) {
    const j = await postJson(api, { appliedFacets: {}, limit: WORKDAY_PAGE_SIZE, offset, searchText: "" });
    if (!j || !Array.isArray(j.jobPostings)) break;
    if (!totalKnown) {
      total = typeof j.total === "number" ? j.total : j.jobPostings.length;
      totalKnown = true;
    }
    for (const p of j.jobPostings) {
      if (!p.externalPath) continue;
      out.push({
        title: p.title || "",
        apply_url: `${base}/${site}${p.externalPath}`,
        location: p.locationsText || (p.bulletFields && p.bulletFields[0]) || "",
        open: true,
        source: "workday",
      });
    }
    if (j.jobPostings.length < WORKDAY_PAGE_SIZE) break; // last page
    offset += WORKDAY_PAGE_SIZE;
  }
  if (offset >= WORKDAY_MAX_POSTINGS && offset < total) {
    console.error(`  workday ${tenant}/${site}: board has ~${total} postings, only scanned ${offset} (cap)`);
  }
  return out.length ? out : null;
}

// Jobvite career sites (https://jobs.jobvite.com/{slug}) — unlike the JSON-API
// providers above, Jobvite serves a plain server-rendered HTML table (class
// "jv-job-list-name" per row, paired "jv-job-list-location"), no client-side JS or
// API call involved (verified live: view-source on jobs.jobvite.com/starwoodcapitalgroup
// shows the full job list already in the HTML). Previously every Jobvite firm fell
// through to a single page-scrape of whichever ONE job a search result happened to
// link to (see extract.js) instead of pulling the whole board. Slugs are NOT reliably
// guessable from a company name (seen: "wpccareers" for W. P. Carey, "src-inc" for
// SRC Inc — no consistent transform), so — like workday — this is only reachable via
// a discovered slug (browse.js's detectAts()), not the guess-by-name PROVIDERS list.
async function jobvite(slug) {
  const res = await rawRequest(`https://jobs.jobvite.com/${slug}`, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
    timeoutMs: 15000,
  });
  if (!res || res.status !== 200) return null;
  const rows = [
    ...res.body.matchAll(
      /<a href="(\/[a-z0-9-]+\/job\/[^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="jv-job-list-location">([\s\S]*?)<\/td>/gi
    ),
  ];
  const out = rows.map((m) => ({
    title: m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
    apply_url: `https://jobs.jobvite.com${m[1]}`,
    location: m[3].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
    open: true,
    source: "jobvite",
  }));
  return out.length ? out : null;
}

// Jibe (SAP SuccessFactors Recruiting Marketing) job-search widget — a search/
// discovery layer many large enterprises run on their OWN careers subdomain
// (e.g. careers.amd.com) IN FRONT OF their real ATS (AMD's is iCIMS underneath —
// apply_url in the response points there). Same-origin JSON API at
// GET https://{domain}/api/jobs?keywords=&page=N, 10 postings/page, a `totalCount`
// on every response (unlike Workday, no first-page-only quirk). Verified live
// against careers.amd.com (1066 postings, clean title/city/state/country/
// apply_url fields) via direct browser network inspection — the widget itself
// is client-rendered (Angular), so this can't be found by a static HTML fetch
// the way jobvite's board could; only by watching the page's real XHR calls.
// slug here is the bare hostname (e.g. "careers.amd.com") — detected via the
// app.jibecdn.com widget-bundle URL appearing in a rendered page (browse.js).
const JIBE_PAGE_SIZE = 10;
const JIBE_MAX_POSTINGS = 500;
async function jibe(domain) {
  const out = [];
  let total = Infinity;
  for (let page = 1; (page - 1) * JIBE_PAGE_SIZE < total && (page - 1) * JIBE_PAGE_SIZE < JIBE_MAX_POSTINGS; page++) {
    const j = await getJson(`https://${domain}/api/jobs?keywords=&page=${page}`);
    if (!j || !Array.isArray(j.jobs)) break;
    if (page === 1) total = typeof j.totalCount === "number" ? j.totalCount : j.jobs.length;
    for (const { data: d } of j.jobs) {
      if (!d) continue;
      out.push({
        title: d.title || "",
        apply_url: d.apply_url || "",
        location: d.full_location || [d.city, d.state, d.country].filter(Boolean).join(", "),
        open: true,
        source: "jibe",
      });
    }
    if (j.jobs.length < JIBE_PAGE_SIZE) break;
  }
  if (out.length >= JIBE_MAX_POSTINGS && out.length < total) {
    console.error(`  jibe ${domain}: board has ~${total} postings, only scanned ${out.length} (cap)`);
  }
  return out.length ? out : null;
}

// Workable — public JSON widget API, no auth needed. Verified live against
// multiple real accounts (greenbacker-capital, nautilus-solar-energy,
// wildlife-works, cultivo). slug is the account name from apply.workable.com/{slug}.
async function workable(slug) {
  const data = await getJson(`https://apply.workable.com/api/v1/widget/accounts/${slug}`);
  if (!data || !Array.isArray(data.jobs)) return null;
  return data.jobs.map((j) => ({
    title: j.title || "",
    apply_url: j.url || j.shortlink || `https://apply.workable.com/${slug}/j/${j.shortcode || ""}`,
    location: j.location && (j.location.city || j.location.country)
      ? [j.location.city, j.location.region, j.location.country].filter(Boolean).join(", ")
      : "",
    open: true,
    source: "workable",
  }));
}

// SmartRecruiters — public JSON API, no auth, well-documented and stable
// (api.smartrecruiters.com/v1/companies/{slug}/postings). Verified live against
// Roland Berger (193 real postings). Public apply page is jobs.smartrecruiters.com/
// {slug}/{id} — confirmed live (200 OK), used since the postings response has no
// direct apply_url field.
const SMARTRECRUITERS_PAGE_SIZE = 100;
async function smartrecruiters(slug) {
  const out = [];
  let offset = 0;
  let total = Infinity;
  while (offset < total) {
    const j = await getJson(`https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=${SMARTRECRUITERS_PAGE_SIZE}&offset=${offset}`);
    if (!j || !Array.isArray(j.content)) break;
    total = typeof j.totalFound === "number" ? j.totalFound : j.content.length;
    for (const p of j.content) {
      out.push({
        title: p.name || "",
        apply_url: `https://jobs.smartrecruiters.com/${slug}/${p.id}`,
        location: (p.location && p.location.fullLocation) || "",
        open: true,
        source: "smartrecruiters",
      });
    }
    if (j.content.length < SMARTRECRUITERS_PAGE_SIZE) break;
    offset += SMARTRECRUITERS_PAGE_SIZE;
  }
  return out.length ? out : null;
}

// governmentjobs.com (NeoGov) — the job board almost every US city/county government
// runs on. The public page itself is a client-rendered Angular shell with no static
// HTML job list (confirmed live), but the AJAX endpoint it calls internally IS plain
// server-rendered HTML — found live via real browser network-request capture
// (Claude-in-Chrome on careers.seattle, watching fetch()/XHR calls): GET
// /careers/home/index?agency={slug}&page=N&sort=PositionTitle&isDescendingSort=false
// with header X-Requested-With: XMLHttpRequest returns a small partial fragment with
// real <a href="/careers/{slug}/jobs/{id}/{title-slug}"> links + location, INSTEAD of
// the full page shell a plain GET returns (verified: partial is ~79KB with 20 job
// links vs ~200KB shell with none). slug is the agency folder name from
// governmentjobs.com/careers/{slug}.
const GOVERNMENTJOBS_MAX_PAGES = 25; // ~20/page -> up to 500 postings, same cap pattern as other adapters
async function governmentjobs(slug) {
  const out = [];
  const seen = new Set();
  for (let page = 1; page <= GOVERNMENTJOBS_MAX_PAGES; page++) {
    const res = await rawRequest(
      `https://www.governmentjobs.com/careers/home/index?agency=${slug}&page=${page}&sort=PositionTitle&isDescendingSort=false`,
      { headers: { "X-Requested-With": "XMLHttpRequest", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }, timeoutMs: 15000 }
    );
    if (!res || res.status !== 200) break;
    const rows = [
      ...res.body.matchAll(
        /href="(\/careers\/[a-z0-9-]+\/jobs\/(\d+)\/[^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<ul class="list-meta">\s*<li>([\s\S]*?)<\/li>/gi
      ),
    ];
    if (!rows.length) break;
    let newOnPage = 0;
    for (const m of rows) {
      const id = m[2];
      if (seen.has(id)) continue;
      seen.add(id);
      newOnPage++;
      out.push({
        title: m[3].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
        apply_url: `https://www.governmentjobs.com${m[1]}`,
        location: m[4].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
        open: true,
        source: "governmentjobs",
      });
    }
    if (!newOnPage) break; // repeated page = end of real pagination
  }
  return out.length ? out : null;
}

// tal.net (Oleeo, formerly WCN) — recurs across several finance firms (BlackRock,
// Evercore, Perella Weinberg, Nomura). Unlike most JS-heavy enterprise ATSes, this
// one IS plain server-rendered HTML (verified live via Claude-in-Chrome page read,
// then confirmed a plain curl returns the identical listing — no browser needed).
// Table rows: <tr data-oppid="ID" data-title="..."><td><a class="subject" href="...">
// Program</a></td><td>Region</td><td>Year</td></tr>. slug is the tenant subdomain
// (e.g. "blackrock" from blackrock.tal.net).
async function talnet(slug) {
  // the vacancy-board ID varies per tenant (seen: 1 for blackrock/nomuracampus, 2 for
  // evercore/pwpcareers) — try the two observed values rather than requiring the
  // caller to know it.
  for (const boardId of [1, 2]) {
    const res = await rawRequest(`https://${slug}.tal.net/vx/candidate/jobboard/vacancy/${boardId}/adv`, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
      timeoutMs: 15000,
    });
    if (!res || res.status !== 200) continue;
    const rows = [
      ...res.body.matchAll(
        /data-oppid="(\d+)"[^>]*>[\s\S]*?<a class="subject" href="([^"]+)">([\s\S]*?)<\/a>[\s\S]*?<td class="comm_list_tbody">([\s\S]*?)<\/td>/gi
      ),
    ];
    if (!rows.length) continue;
    return rows.map((m) => ({
      title: m[3].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
      apply_url: m[2],
      location: m[4].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
      open: true,
      source: "talnet",
    }));
  }
  return null;
}

// iCIMS — recurs across many companies (Stifel/KBW, Costco, PepsiCo, Avison Young,
// Hines, Matthews RE, Getty, Princeton, UCLA, EDF Renewables, Salt Lake/Las Vegas
// libraries, and more). The default /jobs/search page is a pure client-rendered
// shell with no static content (confirmed live — the visible page has only a login
// form), BUT it embeds the real listing in an <iframe src="...?in_iframe=1">, and
// THAT url IS plain server-rendered HTML (found live via Claude-in-Chrome: located
// the iframe src, then confirmed a plain curl on it returns the identical 50-job
// listing). tenant is the subdomain (e.g. "careers-stifel" from
// careers-stifel.icims.com).
async function icims(tenant) {
  const res = await rawRequest(`https://${tenant}.icims.com/jobs/search?in_iframe=1`, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
    timeoutMs: 15000,
  });
  if (!res || res.status !== 200) return null;
  const rows = [
    ...res.body.matchAll(
      /Location<\/span>\s*<span[^>]*>\s*([\s\S]*?)<\/span>[\s\S]*?<a href="([^"]+)"[^>]*title="[^"]*"[^>]*>[\s\S]*?<h3[^>]*>\s*([\s\S]*?)<\/h3>/gi
    ),
  ];
  const out = rows.map((m) => ({
    title: m[3].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
    apply_url: m[2].replace(/\?in_iframe=1$/, ""),
    location: m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
    open: true,
    source: "icims",
  }));
  return out.length ? out : null;
}

// SAP SuccessFactors Career Site Builder — recurs across SMBC, American Airlines,
// EY, TSMC, Duke, George W Bush Center, IDB Invest, African Development Bank. The
// job SEARCH results page (reached via https://careers.{host}/{company}/search/?q=)
// is plain server-rendered HTML (verified live: curl on SMBC's results URL returns
// the identical 25-listing page a real browser search produced — no JS/API needed).
// slug is "{host}/{company}" e.g. "smbcgroup.com/smbc" from careers.smbcgroup.com/smbc.
async function successfactors(slug) {
  const res = await rawRequest(`https://careers.${slug}/search/?q=&locationsearch=`, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
    timeoutMs: 15000,
  });
  if (!res || res.status !== 200) return null;
  const titles = [...res.body.matchAll(/jobTitle-link[^>]*href="([^"]+\/(\d+)\/)"[^>]*>\s*([\s\S]*?)<\/a>/gi)];
  const locs = Object.fromEntries(
    [...res.body.matchAll(/job-(\d+)-desktop-section-location-value">([\s\S]*?)<\/div>/gi)].map((m) => [m[1], m[2]])
  );
  const seen = new Set();
  const out = [];
  const base = `https://careers.${slug.split("/")[0]}`;
  for (const [, url, jid, title] of titles) {
    if (seen.has(jid)) continue;
    seen.add(jid);
    out.push({
      title: title.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
      apply_url: url.startsWith("http") ? url : `${base}${url}`,
      location: (locs[jid] || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
      open: true,
      source: "successfactors",
    });
  }
  return out.length ? out : null;
}

const PROVIDERS = [ashby, greenhouse, lever];
const ADAPTERS = { ashby, greenhouse, lever, workday, jobvite, jibe, workable, smartrecruiters, governmentjobs, talnet, icims, successfactors };

// Fetch a board when the provider + slug are already known (e.g. discovered via the
// browser search fallback). Reuses the same free JSON path.
async function fetchBySlug(provider, slug) {
  const fn = ADAPTERS[provider];
  if (!fn) return null;
  const postings = await fn(slug);
  return postings && postings.length ? postings : null;
}

// Resolve the first provider+slug that returns a non-empty board for this company.
async function resolveBoard(companyName) {
  for (const slug of slugs(companyName)) {
    for (const provider of PROVIDERS) {
      const postings = await provider(slug);
      if (postings && postings.length) {
        return { provider: provider.name, slug, postings };
      }
    }
  }
  return null;
}

module.exports = { resolveBoard, fetchBySlug, slugs };
