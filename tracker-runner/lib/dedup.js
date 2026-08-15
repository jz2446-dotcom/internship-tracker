// lib/dedup.js — cross-category duplicate removal. Pure: operates on in-memory
// category data only; main.js handles all file I/O.

// Specificity order, most specific first. Mirrors analyst/lib/tab-registry.js's
// tab set, minus 'spring2027' (folded into 'fall2026' by the merge step that
// always runs before this).
const CATEGORY_ORDER = [
  'libraries', 'environmental', 'realestate', 'ithaca',
  'sophomore', 'fall2026', 'fellowships', 'china_hk',
  'agent1', 'agent2', 'agent3', 'agent4', 'agent5',
];

function keyOf(entry) {
  return `${(entry.company || '').trim().toLowerCase()}::${(entry.program || '').trim().toLowerCase()}`;
}

// categories: { [categoryId]: { internships: [...], ...rest } }
function dedupCategories(categories) {
  const order = CATEGORY_ORDER.filter((id) => id in categories);
  for (const id of Object.keys(categories)) {
    if (!order.includes(id)) order.push(id);
  }

  const claimed = new Map(); // key -> owning categoryId
  const cleaned = {};
  const removals = [];

  for (const categoryId of order) {
    const data = categories[categoryId];
    const kept = [];
    for (const entry of data.internships || []) {
      const key = keyOf(entry);
      const owner = claimed.get(key);
      if (owner === undefined) {
        claimed.set(key, categoryId);
        kept.push(entry);
      } else if (owner === categoryId) {
        kept.push(entry); // duplicate within the same category — not this feature's job
      } else {
        removals.push({ company: entry.company, program: entry.program || '', from: categoryId, keptIn: owner });
      }
    }
    cleaned[categoryId] = { ...data, internships: kept };
  }
  return { cleaned, removals };
}

module.exports = { CATEGORY_ORDER, dedupCategories };
