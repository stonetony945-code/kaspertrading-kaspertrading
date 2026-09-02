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
import { disconnect, evaluate as evaluateInPage } from '../src/connection.js';
import { summarise } from '../src/core/derived-indicators.js';
import { spawn } from 'node:child_process';
import { evaluate, isComparable, stabiliseDirection } from '../src/core/signal.js';

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
/** --symbols overrides the watchlist; needed when running unattended, where
 *  "whatever is on the chart" is not something we can rely on. */
const SYMBOLS = (argVal('--symbols', '') || '').split(',').map(s => s.trim()).filter(Boolean);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const stamp = () => new Date().toISOString().slice(11, 19);

/** Per-symbol previous tick, so event criteria have something to compare to. */
const previous = new Map();
/** Per-symbol history of raw 1h trend readings, for the hysteresis below. */
const htfHistory = new Map();

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

/**
 * Label sizes SMC uses for its two structure levels, read from the indicator's
 * own inputs rather than assumed: the user can change either, and hardcoding
 * "small" would silently start reading the wrong level if they did.
 * Cached — the settings do not change mid-session.
 */
let cachedSizes = null;
async function smcLabelSizes() {
  if (cachedSizes) return cachedSizes;
  const found = await evaluateInPage(`
    (function() {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      var ids = chart.getAllStudies ? chart.getAllStudies() : [];
      var target = null;
      for (var i = 0; i < ids.length; i++) {
        if (/Smart Money Concepts/i.test(ids[i].name || '')) { target = ids[i].id; break; }
      }
      if (!target) return null;
      var s = chart.getStudyById(target);
      var info = s.getInputsInfo();
      var arr = Array.isArray(info) ? info : (info && info.inputs) || [];
      var vals = {};
      s.getInputValues().forEach(function(v) { vals[v.id] = v.value; });
      var out = {};
      arr.forEach(function(i) {
        if (/Internal Label Size/i.test(i.name || '')) out.internal = vals[i.id];
        if (/Swing Label Size/i.test(i.name || '')) out.swing = vals[i.id];
      });
      return out;
    })()
  `);
  cachedSizes = { swing: found?.swing || 'small', internal: found?.internal || 'tiny' };
  return cachedSizes;
}

async function readSymbol(symbol, timeframe) {
  if (SWITCH) {
    // Only touch the chart when it is not already showing what we want: with a
    // single symbol this makes the monitor a passive reader after the first
    // tick, instead of re-issuing a switch every few minutes.
    const st = await chart.getState().catch(() => null);
    const onSymbol = st?.symbol && (st.symbol === symbol || st.symbol.endsWith(`:${symbol}`));
    const onTimeframe = String(st?.resolution ?? '') === String(timeframe);
    if (!onSymbol) {
      await chart.setSymbol({ symbol });
      await sleep(900);
    }
    if (!onTimeframe) {
      await chart.setTimeframe({ timeframe });
      await sleep(900);
    }
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

  // SMC draws two levels of structure at once, and they disagree constantly:
  // internal structure fires on small moves, swing structure marks the real
  // turns. Taking whichever label came last mixed them, and on 2026-09-02 an
  // internal CHoCH read as "bullish" blocked a bearish setup that the swing
  // structure (a bearish BOS) agreed with. They are told apart by label size,
  // which the indicator's own inputs define.
  let smcDirection = null;
  let smcInternal = null;
  try {
    const sizes = await smcLabelSizes();
    const lab = await data.getPineLabels({ study_filter: 'Smart Money Concepts', max_labels: 60, verbose: true });
    const labels = lab.studies?.[0]?.labels ?? [];
    const lastOf = size => {
      const m = labels.filter(l => l.size === size && l.direction);
      return m.length ? m[m.length - 1].direction : null;
    };
    smcDirection = lastOf(sizes.swing);
    smcInternal = lastOf(sizes.internal);
    // Without swing labels in the window, say nothing rather than fall back to
    // internal: an unknown blocks, a wrong answer trades.
  } catch { /* leave null */ }

  return { cur, ctx: { signalMa, smcDirection, smcInternal } };
}

function describe(symbol, cur, verdicts) {
  const s = cur.stochastic || {};
  const a = cur.atr || {};
  const v = cur.relative_volume || {};
  const h = cur.higher_timeframe || {};
  // Show the side whose filters are open: that is the direction a trigger
  // could actually fire on right now.
  const side = verdicts.bearish.filtersPass ? verdicts.bearish
    : verdicts.bullish.filtersPass ? verdicts.bullish
      : verdicts.bearish;
  const gate = side.filtersPass
    ? `filtres OK (${side.direction})`
    : `bloque: ${side.blockedBy.join(',')}`;
  return `${stamp()}  ${symbol.padEnd(7)} ${String(cur.price).padEnd(11)}`
    + ` K${s.k ?? '—'}/D${s.d ?? '—'}`
    + `  ATR ${a.state ?? '—'}  vol ${v.state ?? '—'}  1h ${h.direction ?? '—'}`
    + `  ${gate}`;
}

/**
 * Push the alert to the desktop. Detached and never awaited: a notification
 * that hangs must not stall the polling loop, and a failure here must not lose
 * the alert — the log line is written regardless.
 */
function notifyDesktop(title, message) {
  try {
    const ps = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', join(ROOT, 'scripts', 'notify.ps1'),
      '-Title', title, '-Message', message,
    ], { detached: true, stdio: 'ignore' });
    ps.unref();
    ps.on('error', () => {});
  } catch { /* the file log is the source of truth */ }
}

function announce(symbol, cur, hit) {
  const lines = [
    '',
    '  ' + '='.repeat(70),
    `  SIGNAL ${hit.direction.toUpperCase()}  ${symbol}  a ${cur.price}   ${new Date().toISOString()}`,
    `  declencheurs : structure ${hit.triggers.structure}, croisement ${hit.triggers.momentum_cross}`,
    `  filtres      : ATR ${cur.atr?.state}, volume ${cur.relative_volume?.state} (x${cur.relative_volume?.ratio}), 1h ${cur.higher_timeframe?.direction}`,
    `  stochastique K ${cur.stochastic?.k} / D ${cur.stochastic?.d}`,
    '  Ceci signale VOS regles. Verifiez le chart — ce n\'est pas une recommandation.',
    '  ' + '='.repeat(70),
    '',
  ];
  console.log(lines.join('\n'));
  notifyDesktop(
    `SIGNAL ${hit.direction.toUpperCase()} — ${symbol}`,
    `${cur.price}  ·  K${cur.stochastic?.k}/D${cur.stochastic?.d}  ·  ATR ${cur.atr?.state}  ·  vol x${cur.relative_volume?.ratio}`
  );
  logLine(`alerts-${today()}.log`, {
    at: new Date().toISOString(), session: sessionOf(), symbol,
    direction: hit.direction, price: cur.price,
    triggers: hit.triggers, filters: hit.filters,
    stochastic: cur.stochastic, atr: cur.atr,
    relative_volume: cur.relative_volume, higher_timeframe: cur.higher_timeframe,
  });
}

async function tick(watchlist, timeframe) {
  for (const symbol of watchlist) {
    try {
      const { cur, ctx } = await readSymbol(symbol, timeframe);

      // Modern standby freezes this process without killing it, so the
      // supervisor sees nothing to restart and the log simply resumes hours
      // later as though the market had been quiet. Detect the hole: report it,
      // and drop the stale reading so no crossing is inferred across it.
      const now = Date.now();
      const stored = previous.get(symbol) ?? null;
      const fresh = stored && isComparable(stored.at, now, INTERVAL_MIN * 60_000);
      let gapMin = null;
      if (stored && !fresh) {
        gapMin = Math.round((now - stored.at) / 60_000);
        const line = `${stamp()}  ${symbol.padEnd(7)} /!\\ TROU DE ${gapMin} MIN — aucune surveillance sur cette periode.`
          + ' Releve precedent ecarte, aucun croisement ne sera deduit par-dessus.';
        console.log(line);
        logLine(`gaps-${today()}.log`, { at: new Date(now).toISOString(), symbol, gap_minutes: gapMin, since: new Date(stored.at).toISOString() });
      }

      // TradingView does not always resume its feed after the machine wakes:
      // CDP answers, the API works, and the bars are hours old. Evaluating
      // that produces confident-looking readings from a dead market, so refuse
      // the tick outright rather than let it through as a normal one. It is
      // also not stored: a frozen bar is not an observation to compare against.
      if (cur.stale) {
        const age = cur.last_bar_age_minutes ?? '?';
        console.log(`${stamp()}  ${symbol.padEnd(7)} /!\\ DONNEES PERIMEES (${age} min) — flux TradingView fige, releve ignore.`);
        logLine(`gaps-${today()}.log`, {
          at: new Date(now).toISOString(), symbol, kind: 'stale_feed',
          last_bar_age_minutes: cur.last_bar_age_minutes ?? null, price: cur.price,
        });
        continue;
      }

      // The 1h trend flips for a single tick near its own crossover, and a
      // filter that vacillates rejects valid setups for a reason that lasts
      // five minutes. Require the same reading twice before the filter acts on
      // it. A gap resets the history: directions either side of a hole are not
      // consecutive observations.
      const hist = (fresh ? htfHistory.get(symbol) : null) ?? [];
      hist.push(cur.higher_timeframe?.direction ?? null);
      if (hist.length > 6) hist.shift();
      htfHistory.set(symbol, hist);
      const settled = stabiliseDirection(hist);
      const rawHtf = cur.higher_timeframe?.direction ?? null;
      if (cur.higher_timeframe) cur.higher_timeframe.direction = settled;

      const prev = fresh ? stored.reading : null;
      const verdicts = evaluate(cur, prev, ctx);
      previous.set(symbol, { reading: cur, at: now });

      console.log(describe(symbol, cur, verdicts));
      logLine(`monitor-${today()}.jsonl`, {
        at: new Date().toISOString(), session: sessionOf(), symbol,
        gap_minutes: gapMin,
        price: cur.price, stale: cur.stale === true,
        stochastic: cur.stochastic, atr: cur.atr,
        relative_volume: cur.relative_volume, higher_timeframe: cur.higher_timeframe,
        htf_raw: rawHtf, htf_settled: settled,
        fvg: cur.fair_value_gaps?.unfilled_total ?? null,
        price_vs_value: cur.volume_profile?.price_vs_value ?? null,
        signal_ma: ctx.signalMa, smc: ctx.smcDirection, smc_internal: ctx.smcInternal,
        bearish: { filters: verdicts.bearish.filters, triggers: verdicts.bearish.triggers, blockedBy: verdicts.bearish.blockedBy },
        bullish: { filters: verdicts.bullish.filters, triggers: verdicts.bullish.triggers, blockedBy: verdicts.bullish.blockedBy },
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
  let watchlist = SYMBOLS.length ? SYMBOLS : (rules.watchlist || []);
  if (!SWITCH && !SYMBOLS.length) {
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
