/**
 * Evaluates the bias criteria against a pair of readings.
 *
 * Two design points, both learned from watching the previous version stay
 * silent for five sessions.
 *
 * 1. Some criteria are events, not states. A stochastic "crossing downward in
 *    the overbought zone" exists for a few bars and is gone. Sampling three
 *    times a day, we watched gold run 96.58 -> 23.55 between captures and only
 *    saw the aftermath. Hence the previous tick is a parameter: the crossing is
 *    reported on the tick it happens, and still counts once the oscillator has
 *    left the zone.
 *
 * 2. Triggers and filters are not the same thing, and scoring them together
 *    hid that. Filters say when NOT to trade and every one must pass; triggers
 *    say when to enter and must agree on a direction. The old model demanded
 *    ATR *expansion* at the same instant as a momentum reversal — states that
 *    rarely coexist, since volatility expands after a turn, not during it. ATR
 *    is now a floor: no compression, rather than active expansion.
 *
 * Every check reports met / unmet / unknown. Unknown is never counted as
 * either: a criterion we cannot measure must not be silently resolved.
 */

const MET = 'met';
const UNMET = 'unmet';
const UNKNOWN = 'unknown';

/** Did %K cross below %D between the two ticks, in or from overbought? */
function crossedDownFromOverbought(prev, cur, threshold = 80) {
  if (!prev || prev.k == null || prev.d == null || cur.k == null || cur.d == null) return null;
  if (!(prev.k >= prev.d && cur.k < cur.d)) return false;
  return prev.k > threshold || cur.k > threshold;
}

/** Did %K cross above %D between the two ticks, in or from oversold? */
function crossedUpFromOversold(prev, cur, threshold = 20) {
  if (!prev || prev.k == null || prev.d == null || cur.k == null || cur.d == null) return null;
  if (!(prev.k <= prev.d && cur.k > cur.d)) return false;
  return prev.k < threshold || cur.k < threshold;
}

const verdict = v => (v === null || v === undefined ? UNKNOWN : v ? MET : UNMET);

/**
 * Direction confirmed by repetition, for readings that flicker.
 *
 * The higher-timeframe trend flips for a single tick near its own crossover —
 * observed three times on 2026-09-02 — and a filter that vacillates rejects
 * valid setups for a reason that lasts five minutes. Requiring the same answer
 * `needed` times running keeps the filter honest without smoothing the data
 * itself.
 *
 * Returns the last direction that held for `needed` consecutive readings, or
 * null while nothing has settled. Null blocks, which is the safe failure.
 */
export function stabiliseDirection(history, needed = 2) {
  if (!Array.isArray(history) || history.length < needed) return null;
  for (let end = history.length; end >= needed; end--) {
    const slice = history.slice(end - needed, end);
    const first = slice[0];
    if (first != null && slice.every(d => d === first)) return first;
  }
  return null;
}

/**
 * Is the previous reading recent enough to compare against?
 *
 * The crossing checks assume two consecutive ticks. If polling stalled -- the
 * machine slept, the process was frozen, TradingView was closed -- the stored
 * reading can be hours old, and comparing across that hole would report a
 * "crossing" that is really just where the market happened to be before and
 * after. On 2026-09-02 the monitor was frozen for eleven hours and resumed as
 * though nothing had happened; without this the first tick back could have
 * fired a signal spanning the whole night.
 *
 * Two intervals of tolerance: one late tick is normal scheduling jitter, two
 * missed in a row is a hole.
 */
export function isComparable(prevAt, now, intervalMs, tolerance = 2) {
  if (prevAt == null || now == null || !(intervalMs > 0)) return false;
  const elapsed = now - prevAt;
  return elapsed >= 0 && elapsed <= intervalMs * tolerance;
}

/**
 * Filters are vetoes: each must be met, and an unknown blocks too. Refusing to
 * trade on a reading we could not take is the conservative failure.
 */
function evaluateFilters(cur, side) {
  const bearish = side === 'bearish';
  const f = {};

  // Volatility floor. Compression invalidates; anything else is acceptable.
  f.volatility_floor = verdict(
    cur.atr?.state == null ? null : cur.atr.state !== 'compressing'
  );

  // Participation: a move nobody is trading is not a move.
  f.participation = verdict(
    cur.relative_volume?.state == null ? null : cur.relative_volume.state !== 'thin'
  );

  // Higher-timeframe context must not oppose the trade. "mixed" is tolerated;
  // only an outright opposite trend blocks.
  const htf = cur.higher_timeframe?.direction ?? null;
  f.trend_context = verdict(
    htf === null ? null : htf === 'mixed' || htf === side
  );

  const blocked = Object.entries(f).filter(([, v]) => v !== MET).map(([k]) => k);
  return { filters: f, pass: blocked.length === 0, blockedBy: blocked };
}

/** Triggers are what actually calls the entry; both must fire on the same side. */
function evaluateTriggers(cur, prev, ctx, side) {
  const bearish = side === 'bearish';
  const t = {};

  t.structure = verdict(ctx.smcDirection == null ? null : ctx.smcDirection === side);

  const cross = bearish
    ? crossedDownFromOverbought(prev?.stochastic, cur.stochastic)
    : crossedUpFromOversold(prev?.stochastic, cur.stochastic);
  t.momentum_cross = verdict(cross);

  const fired = Object.values(t).every(v => v === MET);
  return { triggers: t, fired };
}

function evaluateSide(side, cur, prev, ctx) {
  const { filters, pass, blockedBy } = evaluateFilters(cur, side);
  const { triggers, fired } = evaluateTriggers(cur, prev, ctx, side);
  return {
    direction: side,
    filters,
    triggers,
    filtersPass: pass,
    triggersFired: fired,
    blockedBy,
    signal: pass && fired,
  };
}

export function evaluate(cur, prev, ctx = {}) {
  const bearish = evaluateSide('bearish', cur, prev, ctx);
  const bullish = evaluateSide('bullish', cur, prev, ctx);
  // Both sides firing at once would mean the inputs contradict each other;
  // report neither rather than picking one.
  const both = bearish.signal && bullish.signal;
  return {
    bearish,
    bullish,
    signal: both ? null : bearish.signal ? bearish : bullish.signal ? bullish : null,
    conflict: both,
  };
}

export const _internals = { crossedDownFromOverbought, crossedUpFromOversold, evaluateFilters, evaluateTriggers };
