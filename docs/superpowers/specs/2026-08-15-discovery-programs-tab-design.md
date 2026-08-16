# Discovery Programs tab — design

Date: 2026-08-15
Component: `analyst/` (research engine) + `tracker-runner/` (pipeline registry) +
`cloudflare-worker/` (site rendering)

## Context

The tracker has 14 research tabs, each defined once in `analyst/lib/tab-registry.js`
(shared by `run-analyst.js`, the Tracker Runner Electron app, and the MCP server) and
given tab-specific behavior via `analyst/lib/tab-profiles.js` (a `criteriaPreamble` fed
to the brain, plus a `queryHint` appended to the browser-fallback's last-resort Bing
search). The user wants a new tab tracking **discovery programs** — short (1 day to
2 weeks) insight/exploration/pipeline events firms run, distinct from and usually
earlier than their full summer internship (e.g. "Discovery Day," "Possibilities
Summit," "Insight Week," "Sophomore Summit").

Two prior decisions from this session directly shape this feature:
- **Eligibility filtering is mandatory, not optional.** The user's standing instruction
  (already encoded in the `fellowships` tab's `criteriaPreamble`) is to never surface
  a program he isn't eligible for. His profile: Asian male; qualifies for
  low-income/Pell-restricted programs; does NOT qualify for first-generation-only,
  LGBTQ+-only, veteran-only, disability-only, or race/gender-restricted programs.
- **This engine already does eligibility filtering this way.** `fellowships`'
  `criteriaPreamble` in `analyst/lib/tab-profiles.js:38-41` already states a hard
  eligibility rule and has the brain reject/mark-not-relevant anything the user
  doesn't qualify for. Discovery reuses this exact mechanism — no new eligibility
  subsystem needed, just a correctly-worded preamble.

## What "done" looks like

- A `discovery` entry appears in the Tracker Runner app's pipeline sidebar as
  "Research — Discovery Programs," runs as its own independent process alongside the
  other 14, and produces `data/discovery_results.json`.
- A "Discovery Programs" tab appears on the live site with the same card/status-pill
  treatment as every other tab, deadlines surfaced via the existing "dates" badge.
- Programs restricted to demographics the user doesn't qualify for are dropped before
  ever being written to the output file — not hidden in the UI, actually excluded.
- Discovery-program titles (which rarely contain "intern") are not silently dropped by
  the free title gate the way they would be under the current generic rule.

## Changes, by file

### 1. `analyst/lib/tab-registry.js` — register the tab

Add a `discovery` entry alongside `fellowships`/`sophomore` (same `roster.json`,
`allAgents: true` — discovery programs are run by the same ~207 companies already
tracked, not a new company list):

```js
discovery: { roster: "roster.json", allAgents: true, tab: "discovery", agentName: "discovery", label: "Discovery Programs" },
```

### 2. `analyst/lib/tab-profiles.js` — criteria + eligibility rule

New `discovery` profile entry. The `criteriaPreamble` does two jobs: (a) distinguish a
discovery/insight EVENT from a full internship (already tracked elsewhere — don't
duplicate), and (b) the full eligibility rule, extending `fellowships`' existing
wording to also state the low-income/Pell exception:

```js
discovery: {
  criteriaPreamble: "Short insight/exploration/pipeline EVENTS only (1 day to ~2 weeks: \"Discovery Day\", \"Insight Program\", \"Possibilities Summit\", \"Sophomore Summit\", etc.) — NOT full multi-week summer internships (those are tracked elsewhere; reject if this is really just the regular internship under a different name). HARD ELIGIBILITY RULE: the applicant is an Asian male who qualifies for low-income/Pell-eligible-restricted programs but does NOT qualify for first-generation-college-student-only, LGBTQ+-only, veteran-only, disability-only, or any race/ethnicity/gender-restricted program he doesn't fit (e.g. Black/African-American-only, Hispanic/Latino-only, Native American-only, women-only). Reject/mark not-relevant anything restricted to a category he doesn't qualify for. Programs open to all backgrounds, low-income/Pell-restricted, merit-based, or general-leadership programs are fair game. State the eligibility basis in notes.",
  queryHint: "discovery day insight program",
  searchTerm: "discovery",
},
```

Also add `searchTerm: "intern"` to every existing profile entry (preserves current
behavior exactly — see change 4) rather than leaving it implicit.

### 3. `analyst/lib/classify.js` — discovery needs its own title signal

`titleVerdict`'s `INTERN` regex requires words like "intern"/"internship"/"co-op" —
discovery-program titles essentially never contain these, so every candidate would hit
`hasSignal = false` → `"skip"` before ever reaching the brain, silently producing zero
results (the exact failure mode Ithaca already needed its own `ITHACA_TITLES` regex to
avoid).

Add a `DISCOVERY_TITLES` regex and a `tab === "discovery"` branch:

```js
const DISCOVERY_TITLES = /\b(discovery (day|program|week|summit)|insight (day|week|program)|explore program|possibilities summit|sophomore (summit|program|day)|freshman (summit|program|day)|scholars program|leadership (summit|program)|pipeline program|diversity (day|summit|program))\b/i;
```

Unlike Ithaca (whose title signal alone is strong enough to auto-confirm), a discovery
title alone says nothing about eligibility — every match must still go to the brain.
`titleVerdict` gets a `tab === "discovery"` branch that uses `DISCOVERY_TITLES` as the
signal but always returns `"uncertain"` on a match (never `"confident"`), so
`criteriaPreamble`'s eligibility rule always gets applied before anything is kept.

### 4. `analyst/lib/browse.js` — make the on-page search keyword tab-aware

The interactive-search fix merged earlier hardcodes `"intern"` in two `trySearchKeyword`
calls inside `probePage`. Add a `searchTerm` parameter to `findFirm`/`probePage`
(threaded from the new `tab-profiles.js` field), defaulting to `"intern"` when absent
so every existing tab's behavior is unchanged. Discovery firms get searched for
"discovery" instead when the passive page-load approach finds nothing usable.

### 5. `analyst/run-analyst.js` — thread `searchTerm` through

The existing call `browse.findFirm(wsession, company, profile.queryHint,
careersHints[company])` gains a 5th argument: `profile.searchTerm`.

### 6. `tracker-runner/main.js` — make it show up in the app

Add `'discovery'` to the `TAB_ORDER` array. This is a separately-maintained list from
the registry (not auto-derived from its keys) — both need updating for the tab to
actually run when Start is clicked.

### 7. `cloudflare-worker/build-data.js` and `src/index.js` — wire into the site

Follow the exact pattern of `fellowships`/`environmental`/etc: `build-data.js` loads
`discovery_results.json` into the bundle if present; `index.js` gets a new tab button
and `setTab`/note-panel branch, styled identically to the other tabs (no new CSS —
the Newcrest redesign's existing card/pill/status system applies unchanged).

## Out of scope

- Retrofitting eligibility filtering onto the OTHER tabs. Investigating this feature
  surfaced that `fellowships_results.json` currently has 0 entries, plausibly for the
  exact same title-gate reason discovery would have hit — `fellowships` was never given
  a title-signal regex of its own the way `ithaca` was, and it wasn't discussed as part
  of this request. Worth a look separately; not fixed here.
- A UI toggle for adjusting the eligibility profile from the app — it's a fixed rule in
  the criteria text, edited in code, matching how `fellowships` already works.
- Deadline-specific sorting/highlighting beyond reusing the existing "dates" badge —
  no new UI component.
