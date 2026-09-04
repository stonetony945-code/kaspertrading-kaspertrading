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
import { awaitChart, symbolMatches, resolutionMatches, describeMismatch } from '../src/core/chart-guard.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'snapshots');
const args = process.argv.slice(2);

/** --session <name> tags a capture with the trading session that triggered it. */
const sessionIdx = args.indexOf('--session');
const SESSION = sessionIdx !== -1 ? (args[sessionIdx + 1] || null) : null;

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
  await chart.setTimeframe({ timeframe });

  // The two one-second sleeps that used to stand here were a guess at how long
  // a symbol switch takes, and the monitor proved the guess wrong nine times:
  // the read landed on the previous symbol's bars and was filed under the new
  // symbol's name. Wait for the chart to say it has arrived instead.
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const ready = await awaitChart({ symbol, timeframe, getState: chart.getState, sleep });
  if (!ready) {
    const st = await chart.getState().catch(() => null);
    throw new Error(`capture abandonnee : ${describeMismatch(st, symbol, timeframe)}`);
  }

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

  const smc = { structure: await smcStructure(), zones: await smcZones() };

  // Close the bracket: a capture is a session's reference reading and outlives
  // any single tick, so a chart that moved mid-read must not be filed as one.
  const after = await chart.getState().catch(() => null);
  if (!symbolMatches(after?.symbol, symbol) || !resolutionMatches(after?.resolution, timeframe)) {
    throw new Error(`capture ecartee : le graphique a change pendant la lecture — ${describeMismatch(after, symbol, timeframe)}`);
  }

  return {
    symbol,
    resolution: state.resolution,
    studies: Object.fromEntries((studies.studies || []).map(s => [s.name, s.values])),
    quote: { last: quote.last, time: quote.time, volume: quote.volume },
    derived,
    smc,
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

  const snap = { captured_at: new Date().toISOString(), session: SESSION, timeframe, symbols: [] };
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

  // A capture built on a frozen feed is worse than no capture: it is saved
  // under a session name, becomes the baseline the next --compare diffs
  // against, and reads as a real observation of that session. On 2026-09-04
  // the catch-up runs for Asia and London both fired at 08:15 against bars
  // 676 minutes old and produced two identical, meaningless files.
  //
  // The monitor already refuses stale ticks; this is the same guard for the
  // capture path. Written only if at least one symbol has live data — a
  // partial capture is still worth keeping, a wholly frozen one is not.
  const stale = snap.symbols.filter(s => s.derived?.stale === true);
  const live = snap.symbols.filter(s => s.derived && !s.derived.stale);
  if (stale.length) {
    const ages = stale.map(s => `${s.symbol} ${s.derived.last_bar_age_minutes}min`).join(', ');
    console.log(`\n  /!\\ Donnees perimees : ${ages}`);
  }
  if (!live.length) {
    // Non-zero so the scheduled wrapper retries rather than recording a
    // success: its loop waits and tries again, which is exactly the right
    // response to a feed that has not come back yet.
    console.log('  Aucune donnee fraiche — capture non enregistree.\n');
    process.exitCode = 2;
    return;
  }

  const previous = listSnapshots();
  mkdirSync(DIR, { recursive: true });
  // The session goes in the filename so a capture is identifiable without
  // opening it, and so the scheduler can tell which sessions already ran today.
  const suffix = SESSION ? `__${SESSION}` : '';
  const name = snap.captured_at.replace(/[:.]/g, '-') + suffix + '.json';
  writeFileSync(join(DIR, name), JSON.stringify(snap, null, 2));

  printDigest(snap);
  console.log(`\n  Enregistré : snapshots/${name}${SESSION ? `   (session ${SESSION})` : ''}`);

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
