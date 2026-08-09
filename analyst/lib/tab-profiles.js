// tab-profiles.js — small per-tab behavior table so run-analyst.js can serve all 13
// tracker tabs from one engine instead of one bespoke script per tab. Each profile is
// intentionally light: a criteria preamble (goes into the brain prompt ahead of the
// roster's own description) and a search-query hint (appended to the browser-fallback
// Bing query in lib/browse.js). The free ATS/title-gate pass stays generic — tab-specific
// nuance (region, eligibility, off-cycle term, part-time-only) is enforced by the brain
// reading page_text against the criteria text, matching how the existing `new-refresh`
// skill already carries tab intent through --criteria. Ithaca is the one tab with a real
// engine-level behavior change (job-title gate instead of internship-title gate, hard
// part-time filter) — see lib/classify.js's tab-aware titleVerdict/routeAtsPosting.
const PROFILES = {
  "": { criteriaPreamble: "", queryHint: "" },
  agent1: { criteriaPreamble: "", queryHint: "" },
  agent2: { criteriaPreamble: "", queryHint: "" },
  agent3: { criteriaPreamble: "", queryHint: "" },
  agent4: { criteriaPreamble: "", queryHint: "" },
  agent5: { criteriaPreamble: "", queryHint: "" },
  sophomore: {
    criteriaPreamble: "Genuine multi-week SOPHOMORE-summer internship programs only — exclude 1-day insight/diversity events and standard junior/senior internships.",
    queryHint: "sophomore program",
  },
  fall2026: {
    criteriaPreamble: "Off-cycle / part-time / co-op work terms only (Fall 2026 ~Sept-Dec, or Spring 2027 ~Jan-May) — not the standard Summer internship cycle. Tag which term the posting is for.",
    queryHint: "off-cycle fall winter spring internship",
  },
  libraries: {
    criteriaPreamble: "Finance-function internships only at this cultural/library/museum institution (finance, accounting, endowment/investment office, treasury, development/advancement, business office, budget/financial-planning) — curatorial/collections/librarian roles do NOT count. Prioritize part-time/virtual roles compatible with the school year; include unpaid/stipend roles.",
    queryHint: "finance development internship",
  },
  environmental: {
    criteriaPreamble: "Impact-investing / environmental-finance internships only (impact investing, sustainable/ESG investing, climate finance, green bonds, conservation/natural-capital finance, renewable-energy & infrastructure project finance, carbon markets) — for a big generalist firm, must tie to its named sustainable-investing arm, not its general program.",
    queryHint: "impact investing sustainable finance",
  },
  realestate: {
    criteriaPreamble: "Real-estate finance/investing internships only (RE private equity, acquisitions, asset management, REIT finance, RE investment banking/capital markets, development finance, RE debt/lending, valuation) — leasing/property-management/facilities roles do NOT count.",
    queryHint: "real estate finance investment internship",
  },
  fellowships: {
    criteriaPreamble: "HARD ELIGIBILITY RULE: the applicant is an Asian male. Reject/mark not-relevant any program whose eligibility is restricted to a race/ethnicity/gender the applicant doesn't qualify for (e.g. Black/African-American-only, Hispanic/Latino-only, Native American-only, women-only). Programs open to all backgrounds (including Asian applicants), or merit/need-based/first-gen/geography-based/general-leadership programs, are fair game. State the eligibility basis in notes.",
    queryHint: "fellowship leadership program",
  },
  china_hk: {
    criteriaPreamble: "Only internships based in mainland China or Hong Kong at this firm's HK/China entity (investment banking, asset/wealth management, markets, corporate finance, research) — not the firm's US/global program. Note visa/work-authorization constraints for US-based applicants in notes rather than excluding them.",
    queryHint: "Hong Kong China office",
  },
  ithaca: {
    criteriaPreamble: "HARD FILTER: part-time only, ongoing local job openings (NOT tied to the summer internship cycle) — explicitly including bank tellers, personal bankers, member service reps, loan processing/assistant, treasury/cash-management support, financial-advisor client-service associates, tax-prep associates, Cornell bursar's-office/financial-affairs student jobs. Reject full-time postings outright. If hours aren't stated, mark unknown rather than assuming part-time.",
    queryHint: "part-time teller banker",
  },
};

function get(tab) {
  return PROFILES[tab] || PROFILES[""];
}

module.exports = { get, PROFILES };
