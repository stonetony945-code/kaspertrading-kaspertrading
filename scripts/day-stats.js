#!/usr/bin/env node
/**
 * Per-day summary of what the monitor saw, derived from the tick logs.
 *
 * Answers the question raised on 2026-09-10: is "filters open all day and the
 * stochastic never crosses" an exception or the normal state of this strategy?
 * One day cannot say. A month of days counted identically can.
 *
 * Usage:
 *   node scripts/day-stats.js              # today
 *   node scripts/day-stats.js --all        # every day recorded
 *   node scripts/day-stats.js --date 2026-09-10
 *   node scripts/day-stats.js --all --json # machine-readable
 *
 * Reads only snapshots/monitor-<date>.jsonl. Nothing is written.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { summariseDay, formatDayLine } from '../src/core/day-stats.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'snapshots');
const args = process.argv.slice(2);
const argVal = (name, dflt) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : dflt;
};

function readDay(date) {
  const path = join(DIR, `monitor-${date}.jsonl`);
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

function availableDates() {
  if (!existsSync(DIR)) return [];
  return readdirSync(DIR)
    .map(f => /^monitor-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f))
    .filter(Boolean)
    .map(m => m[1])
    .sort();
}

const dates = args.includes('--all')
  ? availableDates()
  : [argVal('--date', new Date().toISOString().slice(0, 10))];

if (!dates.length) {
  console.log('Aucun journal de releves trouve.');
  process.exit(0);
}

const rows = [];
for (const date of dates) {
  const recs = readDay(date);
  if (!recs || !recs.length) {
    if (!args.includes('--all')) console.log(`Aucun releve pour ${date}.`);
    continue;
  }
  rows.push({ date, stats: summariseDay(recs) });
}

if (args.includes('--json')) {
  console.log(JSON.stringify(rows, null, 2));
  process.exit(0);
}

console.log('\n  date         releves  stochastique   seuils  ecart median  filtres/croisements/signaux par cote');
console.log('  ' + '-'.repeat(110));
for (const { date, stats } of rows) console.log('  ' + formatDayLine(date, stats));

// The point of the table, stated rather than left to the reader.
const openNoTrigger = rows.filter(r =>
  r.stats.sides.bullish.open_but_never_triggered || r.stats.sides.bearish.open_but_never_triggered);
const noOverbought = rows.filter(r => !r.stats.stoch.reached_overbought);
const totalSignals = rows.reduce((n, r) =>
  n + r.stats.sides.bullish.signals + r.stats.sides.bearish.signals, 0);

console.log('');
console.log(`  ${rows.length} jour(s), ${totalSignals} signal(aux) au total.`);
console.log(`  ${openNoTrigger.length} jour(s) avec un cote autorise mais aucun croisement.`);
console.log(`  ${noOverbought.length} jour(s) ou le stochastique n'a jamais atteint 80 (aucune vente possible).`);
console.log('');
console.log('  OB/OS = le stochastique a touche le surachat / la survente dans la journee.');
console.log('  Par cote : % de releves aux filtres ouverts, nombre de croisements, nombre de signaux.\n');
