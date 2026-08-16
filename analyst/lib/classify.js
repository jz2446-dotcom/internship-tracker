// classify.js — the free decision layer. Splits every candidate posting into a
// "confident" pile (settled here, zero tokens) and an "uncertain" pile (handed to
// the brain). Two independent jobs:
//   1. Title gate  — is the title even plausibly an internship in this tab's area?
//   2. Relevance   — can we tell from the title alone it's a genuine fit, or is it
//                    ambiguous prose the brain has to read?

// Cross-cutting keyword sweep (mirrors the skill's Step 2 rule) + finance core.
const FINANCE = /\b(financ|account|treasury|credit|invest|equit|capital|markets?|econom|pricing|valuation|portfolio|wealth|trading|research|analyst|banking|acquisitions?|underwrit|corporate development|fp&a|budget|audit)\b/i;
const INTERN = /\b(intern|internship|co-?op|summer analyst|analyst program|early career|rotational)\b/i;
const EXCLUDE = /\b(senior|staff|principal|lead|manager|director|head of|vp|vice president|leasing|property manager|facilities|custodial|maintenance|janitor)\b/i;

// The Ithaca tab isn't hunting internships — it wants ongoing part-time local jobs
// (explicitly including tellers), so it needs its own title signal instead of INTERN.
const ITHACA_TITLES = /\b(teller|personal banker|member service|financial services rep|loan (processing|processor|assistant)|treasury|cash management|financial advisor|client service associate|tax[- ]?prep|bursar|financial affairs|banking (associate|representative))\b/i;
// Discovery isn't hunting internships either — it wants short insight/pipeline EVENTS,
// which almost never contain "intern"/"internship" in the title (e.g. "Discovery Day",
// "Possibilities Summit") and would otherwise be silently dropped by INTERN, the exact
// failure mode Ithaca already needed its own regex to avoid.
const DISCOVERY_TITLES = /\b(discovery (day|program|week|summit)|insight (day|week|program)|explore program|possibilities summit|sophomore (summit|program|day)|freshman (summit|program|day)|scholars program|leadership (summit|program)|pipeline program|diversity (day|summit|program))\b/i;
const FULL_TIME = /\bfull[- ]?time\b|\b40\s*(hrs?|hours)\s*\/?\s*week\b|\bexempt\b/i;
const PART_TIME = /\bpart[- ]?time\b|\b(1[0-9]|20|25)\s*(hrs?|hours)\s*\/?\s*week\b/i;

// A title clearly fits when it pairs an internship signal with a finance signal and
// carries no exclusion word. Those we can mark relevant for free.
// tab: pass "ithaca" to use the local-job title signal instead of the internship one,
// or "discovery" to use the insight/pipeline-event title signal.
function titleVerdict(title, tab) {
  const t = title || "";
  const hasFinance = FINANCE.test(t);
  const hasSignal = tab === "ithaca" ? ITHACA_TITLES.test(t) : tab === "discovery" ? DISCOVERY_TITLES.test(t) : INTERN.test(t);
  const excluded = EXCLUDE.test(t);
  if (!hasSignal) return "skip";          // not an internship/local-job/event title — drop
  if (excluded) return "skip";            // senior / non-finance-function — drop
  if (tab === "ithaca") return hasSignal ? "confident" : "uncertain"; // ithaca titles ARE the finance signal
  // Discovery: unlike ithaca, a matching title says nothing about eligibility — always
  // send to the brain so criteriaPreamble's hard eligibility rule gets applied before
  // anything is kept, never auto-confirm from title alone.
  if (tab === "discovery") return "uncertain";
  if (hasFinance) return "confident";     // internship + finance + clean → relevant
  return "uncertain";                     // internship but finance unclear → ask brain
}

// Ithaca's hard part-time-only rule: skip full-time outright (never even shortlist),
// keep part-time-confirmed as a strong signal, and let anything ambiguous fall through
// to the brain rather than assuming part-time (per the skill's "mark unknown, not open").
function partTimeGate(text) {
  const t = text || "";
  if (FULL_TIME.test(t)) return "full_time";
  if (PART_TIME.test(t)) return "part_time";
  return "unknown";
}

// Given an ATS posting (presence ⇒ open) decide routing without a browser.
function routeAtsPosting(p, tab) {
  const v = titleVerdict(p.title, tab);
  if (v === "skip") return { route: "skip" };
  if (tab === "ithaca") {
    const pt = partTimeGate(`${p.title} ${p.notes || ""}`);
    if (pt === "full_time") return { route: "skip" }; // hard filter, never shortlist
    if (pt === "unknown") return { route: "uncertain" }; // don't assume part-time — ask brain
  }
  if (v === "confident") return { route: "confident", status: "open" }; // on the live board
  return { route: "uncertain" };
}

// Deterministic open/closed from a JSON-LD JobPosting's validThrough (used on the
// browser path when a self-hosted page exposes structured data).
function verdictFromValidThrough(validThrough, today = new Date()) {
  if (!validThrough) return "unknown";
  const vt = new Date(validThrough);
  if (isNaN(vt)) return "unknown";
  return vt > today ? "open" : "closed";
}

module.exports = { titleVerdict, routeAtsPosting, verdictFromValidThrough, partTimeGate, FINANCE, INTERN, EXCLUDE, ITHACA_TITLES, DISCOVERY_TITLES };
