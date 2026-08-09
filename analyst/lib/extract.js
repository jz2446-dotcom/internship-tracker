// extract.js — the browser fallback for firms not on a public ATS board. Drives
// playwright-cli to render a careers/job page and pull structured data the same way
// we proved on Watershed: JSON-LD JobPosting first (datePosted/validThrough), plus
// the page's own Apply link (which often reveals the real ATS) and body text for the
// brain. All zero-token; the model only runs later, on the text this returns.
const pw = require("./pw");

// Pull the JSON-LD JobPosting block + apply links + a trimmed innerText from a page
// already loaded in `session`.
function scrapeJobPage(session) {
  const fn =
    "() => {" +
    "const ld=[...document.querySelectorAll('script[type=\"application/ld+json\"]')]" +
    ".map(s=>{try{return JSON.parse(s.textContent)}catch(e){return null}})" +
    ".flatMap(o=>Array.isArray(o)?o:[o])" +
    ".find(o=>o&&o['@type']==='JobPosting');" +
    "const applies=[...document.querySelectorAll('a[href]')]" +
    ".filter(a=>/apply/i.test(a.innerText||'')||/ashby|greenhouse|lever|workday|icims/i.test(a.href))" +
    ".map(a=>a.href).filter((v,i,s)=>s.indexOf(v)===i).slice(0,6);" +
    "return {" +
    "jobPosting: ld?{title:ld.title,datePosted:ld.datePosted,validThrough:ld.validThrough," +
    "employmentType:ld.employmentType,location:(ld.jobLocation&&JSON.stringify(ld.jobLocation)||'')}:null," +
    "applyLinks: applies," +
    "text: (document.body.innerText||'').slice(0,9000)" +
    "};}";
  return pw.evalJson(session, fn) || { jobPosting: null, applyLinks: [], text: "" };
}

// Load a URL in a warm session and scrape it. Returns null if the page won't load.
function fetchJobPage(session, url) {
  const r = pw.goto(session, url);
  if (r.code !== 0) return null;
  return scrapeJobPage(session);
}

module.exports = { scrapeJobPage, fetchJobPage };
