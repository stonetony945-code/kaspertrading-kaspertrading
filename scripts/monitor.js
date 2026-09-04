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

import dotenv from 'dotenv';
import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as chart from '../src/core/chart.js';
import * as data from '../src/core/data.js';
import { disconnect, evaluate as evaluateInPage } from '../src/connection.js';
import { summarise } from '../src/core/derived-indicators.js';
import { spawn } from 'node:child_process';
import { evaluate, isComparable, stabiliseDirection } from '../src/core/signal.js';
import { sendTelegram, telegramConfigured, formatSignal } from '../src/core/notify.js';
import { sizePosition, targetDistance, CONTRACT } from '../src/core/position.js';
import { awaitChart, symbolMatches, resolutionMatches, describeMismatch } from '../src/core/chart-guard.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'snapshots');

// dotenv reads from the current working directory, and a scheduled task starts
// in System32 rather than the project. Loading it by path meant the monitor
// silently ran without Telegram in production while working by hand.
dotenv.config({ path: join(ROOT, '.env') });
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
/**
 * Per-symbol count of consecutive ticks whose SMC structure could not be read.
 * The strategy needs two triggers and one of them is the structure, so while
 * this is climbing the monitor cannot emit a signal at all — a state that has
 * to be announced once, not on every tick.
 */
const smcBlindStreak = new Map();
/** Per-symbol count of consecutive ticks refused for a frozen feed. */
const staleStreak = new Map();
/** Account balance from rules.json, for the levels quoted in an alert. */
let ACCOUNT = 100;

function logLine(file, obj) {
  mkdirSync(DIR, { recursive: true });
  appendFileSync(join(DIR, file), JSON.stringify(obj) + '\n', 'utf8');
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * True inside the weekly forex close, which is not a fault however much it
 * looks like one from here: the feed simply stops.
 *
 * The weekend branch in main() covers Saturday and Sunday, leaving Friday
 * evening — where the market shuts around 21:00 UTC but the day is still a
 * weekday, so the monitor keeps polling a dead feed. Approximate on purpose:
 * the exact hour shifts with daylight saving and with the broker. It is used
 * only to word the message, never to skip a reading, so an hour either way
 * costs nothing.
 */
function weeklyClose(d = new Date()) {
  return d.getUTCDay() === 5 && d.getUTCHours() >= 21;
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
  // Only cache a real answer. Caching the fallback would freeze the defaults in
  // for the life of the process, so an SMC re-added to the chart mid-run would
  // keep being read with assumed label sizes instead of its own.
  const sizes = { swing: found?.swing || 'small', internal: found?.internal || 'tiny' };
  if (found?.swing || found?.internal) cachedSizes = sizes;
  return sizes;
}

async function readSymbol(symbol, timeframe) {
  if (SWITCH) {
    // Only touch the chart when it is not already showing what we want: with a
    // single symbol this makes the monitor a passive reader after the first
    // tick, instead of re-issuing a switch every few minutes.
    const st = await chart.getState().catch(() => null);
    if (!symbolMatches(st?.symbol, symbol)) await chart.setSymbol({ symbol });
    if (!resolutionMatches(st?.resolution, timeframe)) await chart.setTimeframe({ timeframe });
  }

  // Wait for the chart to confirm the switch instead of assuming a fixed delay
  // covered it. A 900 ms guess did not, nine times over four days: the read ran
  // against the previous symbol's bars and produced a GBPUSD-labelled tick
  // carrying a four-digit index price. Checked even without --switch, where the
  // chart is the user's and can move under us at any moment.
  const before = await awaitChart({ symbol, timeframe, getState: chart.getState, sleep });
  if (!before) {
    const st = await chart.getState().catch(() => null);
    throw new Error(`lecture abandonnee : ${describeMismatch(st, symbol, timeframe)}`);
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

  // Close the bracket: everything above came from the chart, so confirm it did
  // not move mid-read. Checking only before the read would still let a switch
  // land between the bars and the study values.
  const after = await chart.getState().catch(() => null);
  if (!symbolMatches(after?.symbol, symbol) || !resolutionMatches(after?.resolution, timeframe)) {
    logLine(`gaps-${today()}.log`, {
      at: new Date().toISOString(), symbol, kind: 'symbol_mismatch',
      expected: symbol, expected_timeframe: String(timeframe),
      got: after?.symbol ?? null, got_timeframe: after?.resolution ?? null,
      price_read: cur.price ?? null,
    });
    throw new Error(`releve ecarte : le graphique a change pendant la lecture — ${describeMismatch(after, symbol, timeframe)}`);
  }

  return { cur, ctx: { signalMa, smcDirection, smcInternal } };
}

function describe(symbol, cur, verdicts, ctx = {}) {
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
  // "filtres OK" reads as a healthy tick, and it prints whether or not the
  // structure could be read at all. On 2026-09-04 SMC fell off the chart and 61
  // consecutive ticks looked exactly like this while no signal could physically
  // fire. Say so on the line itself: a blind monitor must not resemble a quiet
  // market.
  const blind = ctx.smcDirection ? '' : '  /!\\ SMC illisible — aucun signal possible';
  return `${stamp()}  ${symbol.padEnd(7)} ${String(cur.price).padEnd(11)}`
    + ` K${s.k ?? '—'}/D${s.d ?? '—'}`
    + `  ATR ${a.state ?? '—'}  vol ${v.state ?? '—'}  1h ${h.direction ?? '—'}`
    + `  ${gate}${blind}`;
}

/**
 * Announce the loss and the return of the SMC structure, once per outage.
 *
 * Deliberately not a per-tick warning: the console line already carries the
 * marker, and a Telegram message every five minutes for hours would train the
 * user to ignore the channel that also carries the signals. One message when
 * the blindness sets in, one when it clears.
 */
function checkStructureReadable(symbol, ctx) {
  const readable = Boolean(ctx.smcDirection);
  const streak = smcBlindStreak.get(symbol) ?? 0;

  if (!readable) {
    smcBlindStreak.set(symbol, streak + 1);
    if (streak !== 0) return;  // already announced for this outage
    const msg = `${symbol} : structure SMC illisible — l'indicateur Smart Money Concepts`
      + ' n\'est plus lisible sur le graphique. Aucun signal ne peut partir tant que c\'est le cas.';
    console.log(`${stamp()}  /!\\ ${msg}`);
    logLine(`gaps-${today()}.log`, {
      at: new Date().toISOString(), symbol, kind: 'smc_unreadable',
    });
    if (telegramConfigured()) {
      sendTelegram(`/!\\ Surveillance aveugle\n\n${msg}`).then(r => {
        if (!r.ok) console.log(`${stamp()}  /!\\ Telegram non delivre : ${r.reason}`);
      });
    }
    return;
  }

  if (streak > 0) {
    smcBlindStreak.set(symbol, 0);
    const msg = `${symbol} : structure SMC de nouveau lisible apres ${streak} releve(s) aveugle(s).`;
    console.log(`${stamp()}  ${msg}`);
    logLine(`gaps-${today()}.log`, {
      at: new Date().toISOString(), symbol, kind: 'smc_recovered', blind_ticks: streak,
    });
    if (telegramConfigured()) {
      sendTelegram(`Surveillance retablie\n\n${msg}`).then(() => {});
    }
  }
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

  // Levels are computed here rather than left to the reader: the alert arrives
  // away from the chart, so the numbers that decide the trade travel with it.
  let stop = null;
  let target = null;
  try {
    const key = symbol.replace(/^[A-Z]+:/, '').toUpperCase();
    const contract = CONTRACT[key];
    if (contract && cur.atr?.value) {
      const sized = sizePosition({ atr: cur.atr.value, account: ACCOUNT, contract });
      const dp = cur.price_decimals ?? 5;
      const dir = hit.direction === 'bearish' ? -1 : 1;
      stop = (cur.price - dir * sized.stopDistance).toFixed(dp);
      target = (cur.price + dir * targetDistance(sized.stopDistance)).toFixed(dp);
    }
  } catch { /* levels are a convenience; the alert matters more */ }

  notifyDesktop(
    `SIGNAL ${hit.direction.toUpperCase()} — ${symbol}`,
    `${cur.price}  ·  K${cur.stochastic?.k}/D${cur.stochastic?.d}  ·  ATR ${cur.atr?.state}  ·  vol x${cur.relative_volume?.ratio}`
  );

  if (telegramConfigured()) {
    // Not awaited: delivery must not stall polling, and the log line below is
    // written whether or not the message gets through.
    sendTelegram(formatSignal({
      symbol, direction: hit.direction, price: cur.price,
      stochastic: cur.stochastic, atr: cur.atr,
      volume: cur.relative_volume, htf: cur.higher_timeframe,
      stop, target,
    })).then(r => {
      if (!r.ok) console.log(`${stamp()}  /!\\ Telegram non delivre : ${r.reason}`);
    });
  }
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
        const streak = staleStreak.get(symbol) ?? 0;
        staleStreak.set(symbol, streak + 1);
        const closed = weeklyClose();
        const why = closed ? 'cloture hebdomadaire du forex' : 'flux TradingView fige';
        console.log(`${stamp()}  ${symbol.padEnd(7)} /!\\ DONNEES PERIMEES (${age} min) — ${why}, releve ignore.`);
        // Once per outage, not once per tick. A frozen feed lasts hours -- the
        // whole weekend, when it is simply the market being shut -- and writing
        // an event every five minutes turned the alert channel into a stream of
        // identical lines nobody would read to the end.
        if (streak === 0) {
          logLine(`gaps-${today()}.log`, {
            at: new Date(now).toISOString(), symbol, kind: 'stale_feed',
            reason: closed ? 'weekly_close' : 'frozen_feed',
            last_bar_age_minutes: cur.last_bar_age_minutes ?? null, price: cur.price,
          });
        }
        continue;
      }
      const wasStale = staleStreak.get(symbol) ?? 0;
      if (wasStale > 0) {
        staleStreak.set(symbol, 0);
        console.log(`${stamp()}  ${symbol.padEnd(7)} flux repris apres ${wasStale} releve(s) ecarte(s).`);
        logLine(`gaps-${today()}.log`, {
          at: new Date(now).toISOString(), symbol, kind: 'feed_recovered', skipped_ticks: wasStale,
        });
      }

      // Structure is one of the two triggers, and an unknown verdict never
      // counts as met — so with SMC off the chart the monitor is not merely
      // less informed, it is incapable of emitting anything. Nothing said so:
      // on 2026-09-04 the indicator was dropped at 09:10 (TradingView Basic
      // caps a chart at two studies) and five hours of ticks kept printing
      // "filtres OK" while three stochastic crossings passed unusable. Warn on
      // the way in and on the way out, once each, so an outage is visible
      // without burying the log.
      checkStructureReadable(symbol, ctx);

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

      console.log(describe(symbol, cur, verdicts, ctx));
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
  ACCOUNT = rules.account?.balance_usd ?? ACCOUNT;
  let watchlist = SYMBOLS.length ? SYMBOLS : (rules.watchlist || []);
  if (!SWITCH && !SYMBOLS.length) {
    const st = await chart.getState();
    watchlist = [st.symbol];
  }

  console.log(`\n  Moniteur — ${watchlist.join(', ')} en ${timeframe} min, releve toutes les ${INTERVAL_MIN} min`);
  console.log(`  Journal : snapshots/monitor-${today()}.jsonl`);
  console.log(`  Telegram : ${telegramConfigured() ? 'configure' : 'non configure (alertes en fichier seulement)'}`);
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
