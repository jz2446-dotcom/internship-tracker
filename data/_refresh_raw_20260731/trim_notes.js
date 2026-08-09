const fs = require('fs');
const path = require('path');
const DATA = path.join(__dirname, '..');

const FILES = [
  'agent1_results.json','agent2_results.json','agent3_results.json','agent4_results.json','agent5_results.json',
  'sophomore_results.json','fall2026_results.json','libraries_results.json','environmental_results.json',
  'realestate_results.json','fellowships_results.json','china_hk_results.json','ithaca_results.json',
];

const MAX_NOTE_LEN = 400;

function trimNotes(notes) {
  if (!notes) return notes;
  // Split on " | " which separates base note from accumulated bracketed verification history
  const parts = notes.split(' | ');
  if (parts.length <= 1) {
    return notes.length > MAX_NOTE_LEN ? notes.slice(0, MAX_NOTE_LEN) + '…' : notes;
  }
  const base = parts[0];
  const bracketed = parts.slice(1).filter(p => /^\[/.test(p.trim()));
  // Keep base note + only the LAST bracketed verification segment (most recent status determination)
  const last = bracketed.length ? bracketed[bracketed.length - 1] : null;
  let result = last ? base + ' | ' + last : base;
  if (result.length > MAX_NOTE_LEN) result = result.slice(0, MAX_NOTE_LEN) + '…';
  return result;
}

let before = 0, after = 0;
for (const f of FILES) {
  const p = path.join(DATA, f);
  const d = JSON.parse(fs.readFileSync(p, 'utf8'));
  for (const e of d.internships) {
    before += (e.notes || '').length;
    e.notes = trimNotes(e.notes);
    after += (e.notes || '').length;
  }
  fs.writeFileSync(p, JSON.stringify(d, null, 2) + '\n');
}
console.log('Notes chars before:', before, '(~' + Math.round(before/1024) + ' KiB)');
console.log('Notes chars after:', after, '(~' + Math.round(after/1024) + ' KiB)');
console.log('Saved:', before - after, 'chars (~' + Math.round((before-after)/1024) + ' KiB)');
