// registry.js — a durable, cross-run memory of HOW to find each company's postings.
// Every research pass previously rediscovered a firm from scratch every single run:
// guess ATS slugs → search → browse → (now) sniff — even for a firm solved last week.
// This persists the WINNING answer (data/_company_conventions.json, no TTL — a
// company's ATS platform choice almost never changes) so future runs can skip straight
// to a validated lookup instead of re-guessing/re-browsing.
//
// Entry shape:
//   known ATS:  { provider: "greenhouse"|"lever"|"ashby"|"workday", slug, discovered, via }
//   bespoke:    { provider: "sniff", hintUrl, discovered, via }
// `via` records which pass found it (ats-guess | search-ats | browse-ats | browse-sniff)
// purely for diagnostics — never read by lookup logic.
const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "..", "data", "_company_conventions.json");

let _cache = null;
function load() {
  if (_cache) return _cache;
  try { _cache = JSON.parse(fs.readFileSync(FILE, "utf8")); }
  catch (_) { _cache = {}; }
  return _cache;
}

function key(company) {
  return (company || "").trim().toLowerCase();
}

function get(company) {
  return load()[key(company)] || null;
}

// Merge-on-save, same pattern as lib/search.js's cache: parallel tab processes each
// hold an in-memory copy, so re-read the file and fold our entry over it before
// writing — concurrent writers never clobber each other's discoveries.
function save() {
  try {
    let onDisk = {};
    try { onDisk = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch (_) {}
    _cache = { ...onDisk, ..._cache };
    fs.writeFileSync(FILE, JSON.stringify(_cache, null, 1));
  } catch (_) {}
}

function record(company, entry, via) {
  const c = load();
  c[key(company)] = { ...entry, discovered: new Date().toISOString().slice(0, 10), via };
  save();
}

// A stored convention stopped working (platform migration, board taken down) — remove
// it rather than leaving a permanently-failing entry; the next run does full discovery
// and re-records whatever it finds (or nothing, if the firm is genuinely gone).
function forget(company) {
  const c = load();
  if (c[key(company)]) { delete c[key(company)]; save(); }
}

module.exports = { get, record, forget, FILE };
