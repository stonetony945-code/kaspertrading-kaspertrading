/**
 * Evaluates the bias criteria from rules.json against a pair of readings.
 *
 * The reason this takes a *previous* reading as well as the current one: two of
 * the criteria are events, not states. A stochastic "crossing downward in the
 * overbought zone" exists for a few bars and is gone. Sampling three times a
 * day, we watched gold run from 96.58 to 23.55 between captures and only saw
 * the aftermath -- the signal itself was never observable. Comparing
 * consecutive ticks catches the crossing on the tick it happens, even once the
 * oscillator has already left the zone.
 *
 * Every check reports met / not met / unknown. Unknown is not failure: a
 * criterion we cannot measure must never be silently counted either way.
 */

const MET = 'met';
const UNMET = 'unmet';
const UNKNOWN = 'unknown';

/** Did %K cross below %D between the two ticks, in or from overbought? */
function crossedDownFromOverbought(prev, cur, threshold = 80) {
  if (!prev || prev.k === null || prev.d === null || cur.k === null || cur.d === null) return null;
  const wasAbove = prev.k >= prev.d;
  const nowBelow = cur.k < cur.d;
  if (!(wasAbove && nowBelow)) return false;
  return prev.k > threshold || cur.k > threshold;
}

/** Did %K cross above %D between the two ticks, in or from oversold? */
function crossedUpFromOversold(prev, cur, threshold = 20) {
  if (!prev || prev.k === null || prev.d === null || cur.k === null || cur.d === null) return null;
  const wasBelow = prev.k <= prev.d;
  const nowAbove = cur.k > cur.d;
  if (!(wasBelow && nowAbove)) return false;
  return prev.k < threshold || cur.k < threshold;
}

function verdict(value) {
  if (value === null || value === undefined) return UNKNOWN;
  return value ? MET : UNMET;
}

/**
 * @param {object} cur   { price, stochastic, atr, fair_value_gaps, volume_profile }
 * @param {object} prev  same shape, or null on the first tick
 * @param {object} ctx   { signalMa, smcDirection } read from the chart
 * @returns {{ direction, score, total, criteria, signal }}
 */
function evaluateSide(side, cur, prev, ctx) {
  const bearish = side === 'bearish';
  const c = {};

  // 1. Market structure: the most recent SMC event's own direction.
  c.smc_structure = verdict(ctx.smcDirection == null ? null : ctx.smcDirection === side);

  // 2. Price relative to the signal moving average.
  c.price_vs_ma = verdict(
    ctx.signalMa == null || cur.price == null
      ? null
      : bearish ? cur.price < ctx.signalMa : cur.price > ctx.signalMa
  );

  // 3. The stochastic crossing -- an event, hence the previous tick.
  const cross = bearish
    ? crossedDownFromOverbought(prev?.stochastic, cur.stochastic)
    : crossedUpFromOversold(prev?.stochastic, cur.stochastic);
  c.stochastic_cross = verdict(cross);

  // 4. Volatility must be expanding; rules.json treats compression as
  //    invalidating regardless of everything else.
  c.atr_expanding = verdict(cur.atr?.state == null ? null : cur.atr.state === 'expanding');

  // 5. Imbalances on the far side of price, with the volume profile agreeing.
  const gaps = cur.fair_value_gaps?.nearest ?? [];
  const wantSide = bearish ? 'above' : 'below';
  const hasGap = gaps.length ? gaps.some(g => g.side === wantSide) : null;
  const vp = cur.volume_profile?.price_vs_value ?? null;
  const vpAgrees = vp == null ? null : (bearish ? vp === 'below' : vp === 'above');
  c.fvg_and_profile = verdict(hasGap == null || vpAgrees == null ? null : hasGap && vpAgrees);

  const values = Object.values(c);
  const score = values.filter(v => v === MET).length;
  const unknown = values.filter(v => v === UNKNOWN).length;

  return {
    direction: side,
    score,
    total: values.length,
    unknown,
    criteria: c,
    // rules.json requires confirmation before entry, and singles out ATR
    // expansion as validating the move. A setup without it is not a setup.
    signal: c.atr_expanding === MET && c.stochastic_cross === MET && score >= 4,
  };
}

export function evaluate(cur, prev, ctx = {}) {
  const bear = evaluateSide('bearish', cur, prev, ctx);
  const bull = evaluateSide('bullish', cur, prev, ctx);
  return { bearish: bear, bullish: bull, signal: bear.signal ? bear : bull.signal ? bull : null };
}

export const _internals = { crossedDownFromOverbought, crossedUpFromOversold };
