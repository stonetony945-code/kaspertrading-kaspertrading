#!/usr/bin/env node
/**
 * Full state snapshot of every watchlist symbol, saved and diffable.
 *
 * Built to compare the same chart before and after the weekly open: nothing in
 * this toolchain has ever been exercised on moving data, so the point is to see
 * which values actually change and whether the staleness flag clears.
 *
 * Usage:
 *   node scripts/snapshot.js              # capture and save
 *   node scripts/snapshot.js --compare    # capture, save, diff against previous
 *   node scripts/snapshot.js --list       # list saved snapshots
 *
 * Requires TradingView running with --remote-debugging-port=9222.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as chart from '../src/core/chart.js';
import * as data from '../src/core/data.js';
import { disconnect } from '../src/connection.js';
import { summarise } from '../src/core/derived-indicators.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'snapshots');
const args = process.argv.slice(2);

function listSnapshots() {
  if (!existsSync(DIR)) return [];
  return readdirSync(DIR).filter(f => f.endsWith('.json')).sort();
}

if (args.includes('--list')) {
  const files = listSnapshots();
  console.log(files.length ? files.join('\n') : 'Aucune capture.');
  process.exit(0);
}

/** Most recent SMC structural events, newest last, with direction already decoded. */
async function smcStructure(limit = 5) {
  try {
    const labels = await data.getPineLabels({ study_filter: 'Smart Money Concepts', max_labels: limit });
    const s = labels.studies?.[0];
    if (!s) return null;
    return s.labels.map(l => ({ text: l.text, price: l.price, direction: l.direction ?? null }));
  } catch { return null; }
}

async function smcZones() {
  try {
    const boxes = await data.getPineBoxes({ study_filter: 'Smart Money Concepts' });
    const s = boxes.studies?.[0];
    if (!s) return null;
    return s.zones.map(z => ({ high: z.high, low: z.low, direction: z.direction ?? null }));
  } catch { return null; }
}

async function captureSymbol(symbol, timeframe) {
  await chart.setSymbol({ symbol });
  await new Promise(r => setTimeout(r, 1000));
  await chart.setTimeframe({ timeframe });
  await new Promise(r => setTimeout(r, 1000));

  const [state, studies, quote] = await Promise.all([
    chart.getState(),
    data.getStudyValues(),
    data.getQuote({}),
  ]);

  let derived = null;
  try {
    const { bars } = await data.getOhlcv({ count: 300 });
    if (bars && bars.length >= 30) derived = summarise(bars);
  } catch (err) { derived = { error: err.message }; }

  return {
    symbol,
    resolution: state.resolution,
    studies: Object.fromEntries((studies.studies || []).map(s => [s.name, s.values])),
    quote: { last: quote.last, time: quote.time, volume: quote.volume },
    derived,
    smc: { structure: await smcStructure(), zones: await smcZones() },
  };
}

/** Only the fields worth watching across the open. */
function digest(sym) {
  const d = sym.derived || {};
  return {
    price: d.price ?? sym.quote?.last ?? null,
    stale: d.stale === true,
    bar_age_min: d.last_bar_age_minutes ?? null,
    stoch_k: d.stochastic?.k ?? null,
    stoch_d: d.stochastic?.d ?? null,
    stoch_state: d.stochastic?.state ?? null,
    atr: d.atr?.value ?? null,
    atr_state: d.atr?.state ?? null,
    atr_ratio: d.atr?.vs_20_period_avg ?? null,
    fvg_unfilled: d.fair_value_gaps?.unfilled_total ?? null,
    poc: d.volume_profile?.poc ?? null,
    price_vs_value: d.volume_profile?.price_vs_value ?? null,
    smc_last: sym.smc?.structure?.length
      ? `${sym.smc.structure.at(-1).text} ${sym.smc.structure.at(-1).price} (${sym.smc.structure.at(-1).direction ?? '?'})`
      : null,
  };
}

function fmt(v) {
  if (v === null || v === undefined) return '—';
  return String(v);
}

function printDigest(snap) {
  for (const sym of snap.symbols) {
    const g = digest(sym);
    console.log(`\n  ${sym.symbol}  ${sym.resolution}min   ${fmt(g.price)}`);
    console.log(`    stale ${g.stale ? 'OUI' : 'non'} (bougie ${fmt(g.bar_age_min)} min)`);
    console.log(`    stoch ${fmt(g.stoch_k)} / ${fmt(g.stoch_d)}  ${fmt(g.stoch_state)}`);
    console.log(`    atr   ${fmt(g.atr)}  ${fmt(g.atr_state)} (x${fmt(g.atr_ratio)})`);
    console.log(`    fvg   ${fmt(g.fvg_unfilled)} non comblés   poc ${fmt(g.poc)} (prix ${fmt(g.price_vs_value)})`);
    console.log(`    smc   ${fmt(g.smc_last)}`);
  }
}

function printDiff(prev, curr) {
  console.log(`\n  Comparaison  ${prev.captured_at}  ->  ${curr.captured_at}`);
  for (const cur of curr.symbols) {
    const old = prev.symbols.find(s => s.symbol === cur.symbol);
    if (!old) { console.log(`\n  ${cur.symbol} : absent de la capture précédente`); continue; }
    const a = digest(old);
    const b = digest(cur);
    console.log(`\n  ${cur.symbol}`);
    let changed = 0;
    for (const k of Object.keys(b)) {
      if (String(a[k]) !== String(b[k])) {
        console.log(`    ${k.padEnd(15)} ${fmt(a[k])}  ->  ${fmt(b[k])}`);
        changed++;
      }
    }
    if (!changed) console.log('    (aucun changement — marché probablement toujours fermé)');
  }
}

async function main() {
  const rules = JSON.parse(readFileSync(join(ROOT, 'rules.json'), 'utf8'));
  const watchlist = rules.watchlist || [];
  const timeframe = rules.default_timeframe || '15';
  if (!watchlist.length) throw new Error('watchlist vide dans rules.json');

  let original = null;
  try { original = await chart.getState(); } catch {}

  const snap = { captured_at: new Date().toISOString(), timeframe, symbols: [] };
  for (const symbol of watchlist) {
    try { snap.symbols.push(await captureSymbol(symbol, timeframe)); }
    catch (err) { snap.symbols.push({ symbol, error: err.message }); }
  }

  // Put the chart back where the user left it.
  if (original?.symbol) {
    try {
      await chart.setSymbol({ symbol: original.symbol });
      if (original.resolution) await chart.setTimeframe({ timeframe: original.resolution });
    } catch {}
  }

  const previous = listSnapshots();
  mkdirSync(DIR, { recursive: true });
  const name = snap.captured_at.replace(/[:.]/g, '-') + '.json';
  writeFileSync(join(DIR, name), JSON.stringify(snap, null, 2));

  printDigest(snap);
  console.log(`\n  Enregistré : snapshots/${name}`);

  if (args.includes('--compare')) {
    if (!previous.length) console.log('\n  Pas de capture antérieure à comparer.');
    else printDiff(JSON.parse(readFileSync(join(DIR, previous.at(-1)), 'utf8')), snap);
  }
  console.log('');
}

main()
  .then(() => disconnect())
  .catch(async (err) => {
    console.error(`Erreur : ${err.message}`);
    try { await disconnect(); } catch {}
    process.exit(1);
  });
