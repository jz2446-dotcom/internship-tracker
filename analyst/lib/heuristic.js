// heuristic.js — the app's OWN brain: a deterministic, zero-network judge. It rules
// FIRST (nimbrain triage calls it before any model); rulings it marks confidence:"high"
// skip the AI entirely, and it is also the last-resort fallback when every NIM model
// is down. Same return shape as nimbrain.judge().
//
// v2 (2026-08-04) upgrades over the original regex-only version:
//   - reads DEADLINE DATES out of the page text and compares them to today
//   - detects STALE CYCLES (a "Summer 2026" posting still up in Aug 2026 is dead)
//   - is CRITERIA-AWARE: scores the tab's own focus keywords, so the museums tab's
//     "Advancement Intern" and the environmental tab's "Climate Finance Intern" count
//     as relevant even where the generic finance regex is thin
//   - maps class-standing phrases (rising junior / penultimate / sophomore) to years
// Design rule throughout: only claim "open" or "closed" on explicit evidence; default
// to "program-page" + confidence:"low" so a live model (or the next refresh) decides.

const FINANCE = /finance|financ|invest|treasury|account|audit|equity|credit|markets|trading|wealth|asset|capital|banking|analyst|econom|pricing|research|m&a|private equity|venture|portfolio|fp&a|real estate|reit|acquisitions|underwrit|valuation|sustainab|esg|climate|impact|endowment|advancement|fundrais|teller|budget/i;
const INTERN = /intern|co-?op|summer analyst|off-?cycle|placement|externship|development program|rotational|leadership program/i;

const MONTHS = "january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec";

// "deadline: March 1, 2027" / "apply by 03/01/2027" / "applications close on 1 March 2027"
const DEADLINE_RE = new RegExp(
  `(?:deadline|apply by|applications?\\s+(?:close|due|accepted until)|closes? on|open until)[:\\s]*(?:is\\s+)?` +
  `((?:${MONTHS})\\.?\\s+\\d{1,2},?\\s+\\d{4}|\\d{1,2}\\s+(?:${MONTHS})\\.?,?\\s+\\d{4}|\\d{1,2}[/-]\\d{1,2}[/-]\\d{2,4})`,
  "i"
);

function parseDeadline(text) {
  const m = text.match(DEADLINE_RE);
  if (!m) return null;
  const t = Date.parse(m[1].replace(/(\d)(st|nd|rd|th)/gi, "$1"));
  return Number.isNaN(t) ? null : new Date(t);
}

// Salient keywords from the tab's criteria string (the same focus text NIM receives),
// so the heuristic judges "relevant to THIS tab", not just "vaguely finance".
const STOP = new Set(["the", "and", "for", "with", "that", "this", "are", "not", "internships", "internship", "intern", "finance", "financial", "firms", "firm", "companies", "company", "roles", "role", "including", "include", "only", "each", "their", "them", "from", "into", "such"]);
function criteriaHits(criteria, text) {
  if (!criteria) return 0;
  const words = [...new Set(criteria.toLowerCase().match(/[a-z][a-z-]{4,}/g) || [])].filter((w) => !STOP.has(w));
  const lower = text.toLowerCase();
  return words.filter((w) => lower.includes(w)).length;
}

function judge(candidate, criteria) {
  const title = candidate.title || "";
  const text = `${title} ${candidate.page_text || ""}`;
  const now = new Date();

  // ---- relevance ----
  // FINANCE is broad by design (matches generic corporate words like "account",
  // "research", "markets", "analyst", "capital") — fine for gating on the TITLE, where
  // those words are a real signal, but scanning the whole ~8000-char page BODY with it
  // false-positives constantly: almost any corporate posting's boilerplate mentions
  // "research" or "markets" somewhere, so a plain Software Engineer posting at a
  // finance-adjacent company was passing as "relevant" (found live 2026-08-06 — Palantir/
  // Databricks/Roblox SWE internships leaking into the Big Tech Corporate Finance tab).
  // Require the finance signal in the TITLE (mirrors classify.js's titleVerdict), with
  // tab-criteria overlap as the deliberate fallback for tabs whose titles don't carry
  // generic finance words (museums' "Advancement Intern", environmental's "Climate
  // Finance Intern") — that path is untouched.
  const titleFinance = FINANCE.test(title);
  const hits = criteriaHits(criteria, text);
  const relevant = INTERN.test(title) && (titleFinance || hits >= 2);

  // ---- status (explicit evidence only, strongest signal first) ----
  let status = "program-page";
  let statusExplicit = false;

  if (/no longer accepting|applications?\s+(are\s+)?closed|deadline (has )?passed|position (has been )?filled|posting (has )?expired/i.test(text)) {
    status = "closed"; statusExplicit = true;
  }

  // A dated deadline in the text is decisive either way.
  if (!statusExplicit) {
    const deadline = parseDeadline(text);
    if (deadline) { status = deadline > now ? "open" : "closed"; statusExplicit = true; }
  }

  // Stale cycle: an internship whose title names a season/year already behind us
  // (e.g. "Summer 2026 Analyst Intern" still up in Aug 2026) is a dead listing no
  // matter what the page's apply button says. Current recruiting cycle = summer of
  // NEXT year once we're past May.
  if (!statusExplicit) {
    const yearMatch = title.match(/\b(20\d{2})\b/);
    if (yearMatch) {
      const y = parseInt(yearMatch[1], 10);
      const currentCycleYear = now.getMonth() >= 4 ? now.getFullYear() + 1 : now.getFullYear();
      if (y < currentCycleYear) { status = "closed"; statusExplicit = true; }
    }
  }

  if (!statusExplicit && /apply now|apply today|accepting applications|submit (your )?application|start (your )?application|apply for this (job|role|position)/i.test(text)) {
    status = "open"; statusExplicit = true;
  }

  // ---- class years ----
  const years = new Set();
  if (/class of 2028|graduating in 2028|2028 grad/i.test(text)) years.add("2028");
  if (/class of 2029|graduating in 2029|2029 grad/i.test(text)) years.add("2029");
  // Class-standing phrases, anchored to the summer-2027 cycle: rising juniors /
  // penultimate-year students that summer are Class of 2028; sophomores are 2029.
  if (/rising junior|penultimate[- ]year|third[- ]year student/i.test(text)) years.add("2028");
  if (/sophomore|second[- ]year student|first[- ]and[- ]second[- ]year/i.test(text)) years.add("2029");
  let class_years = years.size ? [...years] : ["2028", "2029"];
  if (/mba (candidates|students|only)|graduate students only|phd/i.test(text) && !/undergrad/i.test(text)) class_years = [];
  if (/(final[- ]year|graduating senior)s? only/i.test(text)) class_years = [];

  // ---- location ----
  let location = "";
  const locLabel = text.match(/\b(?:location|office)s?\s*[:\-–]\s*([^|•\n]{2,60}?)(?:\s{2,}|[|•]|$)/i);
  if (locLabel) location = locLabel[1].trim();
  else {
    const cityState = text.match(/\b([A-Z][a-z]+(?: [A-Z][a-z]+)?,\s?(?:[A-Z]{2}\b|New York|London|Hong Kong|Singapore|Boston|Chicago|San Francisco))/);
    if (cityState) location = cityState[1].trim();
  }

  // ---- confidence ----
  // "high" only when a model would almost certainly agree:
  //   clear NO — no finance signal AND no meaningful criteria overlap anywhere; or
  //   clear YES — domain right in the title (finance regex or strong criteria overlap)
  //               AND explicit open/closed evidence (phrase, dated deadline, or stale cycle).
  const clearNo = !FINANCE.test(text) && hits < 2;
  const clearYes = relevant && (titleFinance || criteriaHits(criteria, title) >= 1) && statusExplicit;
  const confidence = clearNo || clearYes ? "high" : "low";

  return {
    relevant,
    status,
    class_years,
    location,
    notes: confidence === "high" ? "heuristic ruling (explicit evidence)" : "heuristic ruling (uncertain) — re-judged next refresh",
    confidence,
  };
}

module.exports = { judge };
