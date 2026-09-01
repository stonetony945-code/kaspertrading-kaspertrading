/**
 * Indicators derived from raw OHLCV bars.
 *
 * TradingView's Basic plan caps a chart at 2 indicators. These functions
 * reproduce the missing ones from bar data instead, so they cost no chart
 * slot and can all be read at once. Formulas follow TradingView's built-ins.
 *
 * Distinct from core/indicators.js, which manages studies already placed on
 * the chart (inputs, visibility). Nothing here touches the chart.
 *
 * Every series returned is aligned to the input bars: index i of a result
 * corresponds to bars[i], and leading values are null until enough bars
 * exist to compute them. Callers should treat null as "not available",
 * never as zero.
 */

const round = (v, dp = 2) => (v === null || v === undefined ? null : Number(v.toFixed(dp)));

/**
 * Price precision varies wildly by instrument: gold quotes ~4454.99, GBPUSD
 * ~1.35319. A fixed 2-decimal round collapses forex levels into meaningless
 * duplicates, so infer the instrument's real precision from its own bars.
 */
export function inferDecimals(bars) {
  const values = [];
  for (const b of bars.slice(-50)) values.push(b.close, b.high, b.low);
  return decimalsOfValues(values);
}

/**
 * Same inference over a bare list of prices, for callers that have levels but
 * no bars (the Pine drawing tools). Needs to see at least one value at full
 * precision, which is a safe bet across dozens of samples but not over two or
 * three round numbers.
 */
export function decimalsOfValues(values) {
  let max = 0;
  for (const v of values) {
    if (v === null || v === undefined || !Number.isFinite(v)) continue;
    // Live feeds carry floating-point noise: a bar open of 1.35312 arrives as
    // 1.3531199999999999, which String() reports as 16 decimals and would peg
    // precision at the cap. Normalising first recovers the real tick size.
    const s = String(parseFloat(v.toFixed(8)));
    const dot = s.indexOf('.');
    if (dot !== -1) max = Math.max(max, s.length - dot - 1);
  }
  return Math.min(Math.max(max, 2), 8);
}

/** ATR alone says little; comparing it to its own recent average says whether volatility is expanding. */
function atrRegime(series) {
  const valid = series.filter(v => v !== null);
  if (valid.length < 20) return { state: 'unknown', ratio: null };
  const last = valid[valid.length - 1];
  const avg = valid.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const ratio = last / avg;
  return { state: ratio > 1.15 ? 'expanding' : ratio < 0.85 ? 'compressing' : 'stable', ratio };
}

function stochState(k, d) {
  if (k === null || d === null) return 'unavailable';
  if (k < 20) return k > d ? 'oversold_bullish_cross' : 'oversold';
  if (k > 80) return k < d ? 'overbought_bearish_cross' : 'overbought';
  return 'neutral';
}

/**
 * Build the compact report consumed by both the data_get_derived_indicators
 * tool and morning_brief. Kept here, and pure, so the two callers can never
 * drift apart — and so it stays unit-testable without a chart connection.
 *
 * `include` is a Set of: stochastic, atr, fvg, volume_profile.
 */
export function summarise(bars, { include, options = {} } = {}) {
  const want = include || new Set(['stochastic', 'atr', 'fvg', 'volume_profile', 'volume', 'htf']);
  const last = bars[bars.length - 1];
  const price = last.close;
  const dp = inferDecimals(bars);
  const out = { bar_count: bars.length, price, price_decimals: dp };

  // A brief built on stale bars reads as current unless the age is stated:
  // over a weekend or an outage the newest bar can be days old.
  if (last.time) {
    const ageMin = Math.round((Date.now() - last.time * 1000) / 60000);
    out.last_bar_time = new Date(last.time * 1000).toISOString();
    out.last_bar_age_minutes = ageMin;
    if (ageMin > 120) {
      out.stale = true;
      out.stale_warning = `Newest bar is ${Math.round(ageMin / 60)}h old — market likely closed. These are not live readings.`;
    }
  }

  if (want.has('stochastic')) {
    const s = stochastic(bars, {
      periodK: options.stoch_period_k || 14,
      smoothK: options.stoch_smooth_k || 1,
      periodD: options.stoch_period_d || 3,
    });
    out.stochastic = { k: round(s.lastK), d: round(s.lastD), state: stochState(s.lastK, s.lastD) };
  }

  if (want.has('atr')) {
    const a = atr(bars, { period: options.atr_period || 14 });
    const regime = atrRegime(a.atr);
    out.atr = {
      value: round(a.last, dp + 1),
      pct_of_price: round((a.last / price) * 100, 3),
      state: regime.state,
      vs_20_period_avg: round(regime.ratio, 2),
    };
  }

  if (want.has('fvg')) {
    const gaps = fairValueGaps(bars);
    out.fair_value_gaps = {
      unfilled_total: gaps.length,
      nearest: gaps
        .map(g => ({ ...g, distance: Math.min(Math.abs(price - g.top), Math.abs(price - g.bottom)) }))
        .sort((x, y) => x.distance - y.distance)
        .slice(0, options.max_gaps || 5)
        .map(g => ({
          type: g.type,
          bottom: round(g.bottom, dp),
          top: round(g.top, dp),
          size: round(g.size, dp),
          distance: round(g.distance, dp),
          side: g.bottom > price ? 'above' : 'below',
        })),
    };
  }

  if (want.has('volume')) {
    const rv = relativeVolume(bars, { period: options.volume_period || 20 });
    out.relative_volume = rv && {
      ratio: round(rv.ratio, 2),
      state: rv.state,
      volume: Math.round(rv.volume),
      average: Math.round(rv.average),
    };
  }

  if (want.has('htf')) {
    const h = higherTimeframeTrend(bars, {
      seconds: options.htf_seconds || 3600,
      period: options.htf_period || 20,
    });
    out.higher_timeframe = h && {
      timeframe: `${(options.htf_seconds || 3600) / 60}min`,
      ema: round(h.ema, dp),
      price: round(h.price, dp),
      above_ema: h.above,
      direction: h.direction,
      bars: h.bars,
      note: 'EMA computed from aggregated bars, not the LuxAlgo Signal MA.',
    };
  }

  if (want.has('volume_profile')) {
    const vp = volumeProfile(bars, { bins: options.vp_bins || 24 });
    out.volume_profile = vp && {
      poc: round(vp.poc, dp),
      value_area_high: round(vp.valueAreaHigh, dp),
      value_area_low: round(vp.valueAreaLow, dp),
      price_vs_value: price > vp.valueAreaHigh ? 'above' : price < vp.valueAreaLow ? 'below' : 'inside',
      approximate: true,
      note: 'Bar-derived approximation — no intrabar volume available. Treat levels as zones.',
    };
  }

  return out;
}

/**
 * Volume of the last completed bar against its own recent average.
 *
 * Answers a question none of the price-based criteria can: is this move
 * carried, or hollow? Independent of where price sits, which is what makes it
 * worth a criterion slot — the Sunday reopen moved prices on almost no
 * participation, and nothing in a structure reading says so.
 *
 * The forming bar is excluded: it is partial by definition and always looks
 * thin, which would veto every signal near the open of a bar.
 */
export function relativeVolume(bars, { period = 20 } = {}) {
  if (bars.length < period + 2) return null;
  const closed = bars.slice(0, -1);                 // drop the bar still forming
  const last = closed[closed.length - 1];
  const window = closed.slice(-1 - period, -1);
  if (window.length < period) return null;
  const avg = window.reduce((a, b) => a + b.volume, 0) / window.length;
  if (!(avg > 0)) return null;
  const ratio = last.volume / avg;
  return {
    volume: last.volume,
    average: avg,
    ratio,
    state: ratio >= 1.2 ? 'high' : ratio <= 0.6 ? 'thin' : 'normal',
  };
}

/**
 * Group bars into a higher timeframe by wall-clock bucket.
 *
 * Bucketing on the bar's own timestamp rather than chunking every N bars keeps
 * the candles aligned to real hour boundaries even when the feed has gaps —
 * over a weekend, blind chunking would straddle the break and invent a candle
 * that never traded.
 */
export function aggregate(bars, { seconds = 3600 } = {}) {
  const out = [];
  let cur = null;
  let bucket = null;
  for (const b of bars) {
    const k = Math.floor(b.time / seconds);
    if (k !== bucket) {
      if (cur) out.push(cur);
      bucket = k;
      cur = { time: k * seconds, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume };
    } else {
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      cur.close = b.close;
      cur.volume += b.volume;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Exponential moving average, null-padded until the seed. */
function emaSeries(values, n) {
  const out = new Array(values.length).fill(null);
  if (values.length < n) return out;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += values[i];
  out[n - 1] = sum / n;
  const k = 2 / (n + 1);
  for (let i = n; i < values.length; i++) out[i] = values[i] * k + out[i - 1] * (1 - k);
  return out;
}

/**
 * Trend on a higher timeframe, derived from the same bars.
 *
 * Built by aggregation rather than by switching the chart: re-reading at
 * another resolution would flip the user's display and take seconds per poll.
 * The average is our own EMA, not the LuxAlgo Signal MA — that script is
 * closed, so this is a different measure serving the same purpose, and it is
 * reported under its own name to avoid implying otherwise.
 */
export function higherTimeframeTrend(bars, { seconds = 3600, period = 20 } = {}) {
  const htf = aggregate(bars, { seconds });
  if (htf.length < period + 2) return null;
  const closes = htf.map(b => b.close);
  const ema = emaSeries(closes, period);
  const last = ema[ema.length - 1];
  const prev = ema[ema.length - 2];
  if (last === null || prev === null) return null;
  const price = closes[closes.length - 1];
  const slope = last - prev;
  return {
    bars: htf.length,
    ema: last,
    price,
    above: price > last,
    slope,
    direction: slope > 0 && price > last ? 'bullish' : slope < 0 && price < last ? 'bearish' : 'mixed',
  };
}

/** Simple moving average over a series, preserving null-padding. */
function smaSeries(values, n) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  let count = 0;
  const window = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v === null) { window.length = 0; sum = 0; count = 0; continue; }
    window.push(v); sum += v; count++;
    if (count > n) { sum -= window.shift(); count--; }
    if (count === n) out[i] = sum / n;
  }
  return out;
}

/**
 * Wilder's smoothing (RMA) — what TradingView's ATR uses, not a plain SMA.
 * Seeded with an SMA of the first n values, then recursive.
 */
function rmaSeries(values, n) {
  const out = new Array(values.length).fill(null);
  if (values.length < n) return out;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += values[i];
  out[n - 1] = sum / n;
  for (let i = n; i < values.length; i++) {
    out[i] = (out[i - 1] * (n - 1) + values[i]) / n;
  }
  return out;
}

/**
 * Stochastic oscillator.
 * %K = 100 * (close - lowest(low, periodK)) / (highest(high, periodK) - lowest(low, periodK))
 * %D = SMA(%K, periodD)
 *
 * TradingView's built-in defaults are periodK 14, smoothK 1, periodD 3.
 * Returns null for a bar whose window is entirely flat (zero range), rather
 * than inventing a value for an undefined division.
 */
export function stochastic(bars, { periodK = 14, smoothK = 1, periodD = 3 } = {}) {
  const raw = new Array(bars.length).fill(null);
  for (let i = periodK - 1; i < bars.length; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - periodK + 1; j <= i; j++) {
      if (bars[j].high > hh) hh = bars[j].high;
      if (bars[j].low < ll) ll = bars[j].low;
    }
    const range = hh - ll;
    raw[i] = range === 0 ? null : ((bars[i].close - ll) / range) * 100;
  }
  const k = smoothK > 1 ? smaSeries(raw, smoothK) : raw;
  const d = smaSeries(k, periodD);
  return { k, d, lastK: k[k.length - 1], lastD: d[d.length - 1] };
}

/**
 * Average True Range.
 * TR = max(high-low, |high-prevClose|, |low-prevClose|); ATR = RMA(TR, period).
 * The first bar has no previous close, so its TR is just high-low.
 */
export function atr(bars, { period = 14 } = {}) {
  const tr = new Array(bars.length);
  tr[0] = bars[0].high - bars[0].low;
  for (let i = 1; i < bars.length; i++) {
    const prevClose = bars[i - 1].close;
    tr[i] = Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - prevClose),
      Math.abs(bars[i].low - prevClose)
    );
  }
  const series = rmaSeries(tr, period);
  return { tr, atr: series, last: series[series.length - 1] };
}

/**
 * Fair Value Gaps — the 3-bar imbalance used by Smart Money Concepts.
 * Bullish when bar i's low clears bar i-2's high; bearish when bar i's high
 * stays under bar i-2's low. A gap is "filled" once a later bar trades back
 * into it, which is what makes an unfilled gap worth watching.
 */
export function fairValueGaps(bars, { includeFilled = false } = {}) {
  const gaps = [];
  for (let i = 2; i < bars.length; i++) {
    const left = bars[i - 2];
    const cur = bars[i];
    let gap = null;
    if (cur.low > left.high) {
      gap = { type: 'bullish', bottom: left.high, top: cur.low, index: i, time: cur.time };
    } else if (cur.high < left.low) {
      gap = { type: 'bearish', bottom: cur.high, top: left.low, index: i, time: cur.time };
    }
    if (!gap) continue;

    // Walk forward: the gap is filled once price re-enters the band.
    gap.filled = false;
    for (let j = i + 1; j < bars.length; j++) {
      if (bars[j].low <= gap.top && bars[j].high >= gap.bottom) { gap.filled = true; break; }
    }
    gap.size = gap.top - gap.bottom;
    if (includeFilled || !gap.filled) gaps.push(gap);
  }
  return gaps;
}

/**
 * Volume profile approximated from bar data.
 *
 * A true profile needs intrabar tick volume, which the chart API does not
 * expose. This spreads each bar's volume uniformly across its high-low range
 * into price bins — the standard approximation. It locates the high-volume
 * node (POC) and value area reliably, but is NOT tick-accurate; treat the
 * levels as zones, not exact prices.
 */
export function volumeProfile(bars, { bins = 24, valueAreaPct = 0.7 } = {}) {
  const hi = Math.max(...bars.map(b => b.high));
  const lo = Math.min(...bars.map(b => b.low));
  const span = hi - lo;
  if (span <= 0) return null;

  const binSize = span / bins;
  const hist = new Array(bins).fill(0);

  for (const b of bars) {
    const range = b.high - b.low;
    const first = Math.min(bins - 1, Math.max(0, Math.floor((b.low - lo) / binSize)));
    const last = Math.min(bins - 1, Math.max(0, Math.floor((b.high - lo) / binSize)));
    if (range <= 0 || first === last) { hist[first] += b.volume; continue; }
    const share = b.volume / (last - first + 1);
    for (let k = first; k <= last; k++) hist[k] += share;
  }

  const priceOf = (i) => lo + binSize * (i + 0.5);
  let pocIdx = 0;
  for (let i = 1; i < bins; i++) if (hist[i] > hist[pocIdx]) pocIdx = i;

  // Grow the value area outward from the POC until it holds the target share.
  const total = hist.reduce((a, b) => a + b, 0);
  const target = total * valueAreaPct;
  let lower = pocIdx;
  let upper = pocIdx;
  let acc = hist[pocIdx];
  while (acc < target && (lower > 0 || upper < bins - 1)) {
    const below = lower > 0 ? hist[lower - 1] : -1;
    const above = upper < bins - 1 ? hist[upper + 1] : -1;
    if (above >= below) { upper++; acc += hist[upper]; }
    else { lower--; acc += hist[lower]; }
  }

  return {
    poc: priceOf(pocIdx),
    valueAreaHigh: priceOf(upper),
    valueAreaLow: priceOf(lower),
    binSize,
    high: hi,
    low: lo,
    approximate: true,
  };
}
