#!/usr/bin/env node
/**
 * Continuous session monitor.
 *
 * Three snapshots a day cannot see this strategy's signals. On 2026-09-01 gold
 * ran from a 96.58 stochastic to 23.55 between two captures seven hours apart:
 * the crossing rules.json asks for happened, moved price 53 points, and was
 * never observable. A 15-minute strategy needs sampling in minutes.
 *
 * So this polls on a short interval, evaluates the criteria against the
 * previous tick rather than in isolation, and says something only when they
 * line up. Every tick is appended to a JSONL log, which also gives the
 * intraday series the snapshots never had.
 *
 * Usage:
 *   node scripts/monitor.js                  # every 5 min, all watchlist symbols
 *   node scripts/monitor.js --interval 3     # minutes between ticks
 *   node scripts/monitor.js --no-switch      # only the symbol already on screen
 *   node scripts/monitor.js --once           # a single pass, then exit
 *
 * NOTE: with more than one symbol the chart is switched on every tick, so the
 * display will flip. Use --no-switch when you are working on the chart.
 */

import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as chart from '../src/core/chart.js';
import * as data from '../src/core/data.js';
import { disconnect } from '../src/connection.js';
import { summarise } from '../src/core/derived-indicators.js';
import { evaluate } from '../src/core/signal.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'snapshots');
const args = process.argv.slice(2);
const argVal = (name, dflt) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : dflt;
};

const INTERVAL_MIN = Number(argVal('--interval', '5'));
const SWITCH = !args.includes('--no-switch');
const ONCE = args.includes('--once');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const stamp = () => new Date().toISOString().slice(11, 19);

/** Per-symbol previous tick, so event criteria have something to compare to. */
const previous = new Map();

function logLine(file, obj) {
  mkdirSync(DIR, { recursive: true });
  appendFileSync(join(DIR, file), JSON.stringify(obj) + '\n', 'utf8');
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

/** Which session an instant falls in, for context in the log. */
function sessionOf(d = new Date()) {
  const h = d.getUTCHours();
  if (h >= 12 && h < 21) return 'newyork';
  if (h >= 7 && h < 12) return 'londres';
  if (h < 7 || h >= 21) return 'asie';
  return 'hors-session';
}

async function readSymbol(symbol, timeframe) {
  if (SWITCH) {
    await chart.setSymbol({ symbol });
    await sleep(900);
    await chart.setTimeframe({ timeframe });
    await sleep(900);
  }

  const { bars } = await data.getOhlcv({ count: 300 });
  if (!bars || bars.length < 30) throw new Error(`pas assez de bougies (${bars?.length ?? 0})`);
  const cur = summarise(bars);

  let signalMa = null;
  try {
    const sv = await data.getStudyValues();
    const ma = (sv.studies || []).find(s => /Signal Moving/i.test(s.name));
    if (ma) {
      const raw = Object.values(ma.values)[0];
      // The chart formats numbers for display: "4 444,821".
      const n = parseFloat(String(raw).replace(/\s/g, '').replace(',', '.'));
      if (Number.isFinite(n)) signalMa = n;
    }
  } catch { /* leave null -> criterion reports unknown */ }

  let smcDirection = null;
  try {
    const lab = await data.getPineLabels({ study_filter: 'Smart Money Concepts', max_labels: 1 });
    smcDirection = lab.studies?.[0]?.labels?.[0]?.direction ?? null;
  } catch { /* leave null */ }

  return { cur, ctx: { signalMa, smcDirection } };
}

function describe(symbol, cur, verdicts) {
  const s = cur.stochastic || {};
  const a = cur.atr || {};
  const best = verdicts.bearish.score >= verdicts.bullish.score ? verdicts.bearish : verdicts.bullish;
  return `${stamp()}  ${symbol.padEnd(7)} ${String(cur.price).padEnd(11)}`
    + ` K${s.k ?? '—'}/D${s.d ?? '—'}  ATR ${a.state ?? '—'} x${a.vs_20_period_avg ?? '—'}`
    + `  ${best.direction} ${best.score}/${best.total}`
    + (best.unknown ? ` (${best.unknown} inconnu)` : '');
}

function announce(symbol, cur, hit) {
  const met = Object.entries(hit.criteria).filter(([, v]) => v === 'met').map(([k]) => k);
  const lines = [
    '',
    '  ' + '='.repeat(66),
    `  SIGNAL ${hit.direction.toUpperCase()}  ${symbol}  a ${cur.price}   ${new Date().toISOString()}`,
    `  ${hit.score}/${hit.total} criteres : ${met.join(', ')}`,
    `  Stochastique K ${cur.stochastic?.k} / D ${cur.stochastic?.d}`,
    `  ATR ${cur.atr?.value} ${cur.atr?.state} x${cur.atr?.vs_20_period_avg}`,
    '  Verifiez le chart avant toute decision — ceci signale vos regles, pas une recommandation.',
    '  ' + '='.repeat(66),
    '',
  ];
  console.log(lines.join('\n'));
  logLine(`alerts-${today()}.log`, {
    at: new Date().toISOString(), session: sessionOf(), symbol,
    direction: hit.direction, price: cur.price, score: hit.score,
    criteria: hit.criteria, stochastic: cur.stochastic, atr: cur.atr,
  });
}

async function tick(watchlist, timeframe) {
  for (const symbol of watchlist) {
    try {
      const { cur, ctx } = await readSymbol(symbol, timeframe);
      const prev = previous.get(symbol) ?? null;
      const verdicts = evaluate(cur, prev, ctx);
      previous.set(symbol, cur);

      console.log(describe(symbol, cur, verdicts));
      logLine(`monitor-${today()}.jsonl`, {
        at: new Date().toISOString(), session: sessionOf(), symbol,
        price: cur.price, stale: cur.stale === true,
        stochastic: cur.stochastic, atr: cur.atr,
        fvg: cur.fair_value_gaps?.unfilled_total ?? null,
        price_vs_value: cur.volume_profile?.price_vs_value ?? null,
        signal_ma: ctx.signalMa, smc: ctx.smcDirection,
        bearish: verdicts.bearish.score, bullish: verdicts.bullish.score,
        criteria_bearish: verdicts.bearish.criteria,
        criteria_bullish: verdicts.bullish.criteria,
      });

      if (verdicts.signal) announce(symbol, cur, verdicts.signal);
    } catch (err) {
      console.log(`${stamp()}  ${symbol.padEnd(7)} erreur : ${err.message}`);
    }
  }
}

async function main() {
  const rules = JSON.parse(readFileSync(join(ROOT, 'rules.json'), 'utf8'));
  const timeframe = rules.default_timeframe || '15';
  let watchlist = rules.watchlist || [];
  if (!SWITCH) {
    const st = await chart.getState();
    watchlist = [st.symbol];
  }

  console.log(`\n  Moniteur — ${watchlist.join(', ')} en ${timeframe} min, releve toutes les ${INTERVAL_MIN} min`);
  console.log(`  Journal : snapshots/monitor-${today()}.jsonl`);
  if (SWITCH && watchlist.length > 1) console.log('  Le chart changera de symbole a chaque releve (--no-switch pour l\'eviter).');
  console.log('  Ctrl+C pour arreter.\n');

  for (;;) {
    const d = new Date();
    const day = d.getUTCDay();
    if (day === 0 || day === 6) {
      console.log(`${stamp()}  week-end — en attente`);
    } else {
      await tick(watchlist, timeframe);
    }
    if (ONCE) break;
    await sleep(INTERVAL_MIN * 60_000);
  }
}

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  console.log('\n  Arret du moniteur.');
  try { await disconnect(); } catch { /* ignore */ }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main()
  .then(() => shutdown())
  .catch(async (err) => {
    console.error(`Erreur fatale : ${err.message}`);
    try { await disconnect(); } catch { /* ignore */ }
    process.exit(1);
  });
