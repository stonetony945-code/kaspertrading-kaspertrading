/**
 * What a day of monitoring actually contained.
 *
 * On 2026-09-10 the bearish filters were open on 53 of 54 ticks, price fell 69
 * pips in exactly that direction, and not one signal fired: the momentum
 * trigger wants a cross down from overbought, and in a sustained decline the
 * stochastic never climbs back there -- it peaked at 68.5 and spent the day
 * between 1 and 50.
 *
 * One day proves nothing. The question worth answering is whether "filters open
 * all day, no crossing" is the exception or the rule, and that needs weeks of
 * days counted the same way. Everything required is already in the per-tick
 * JSONL, so this derives rather than records: it cannot drift from the ticks,
 * and it works on the days already written.
 */

const SIDES = ['bullish', 'bearish'];

/** Numbers survive a round trip through some locales as "1,35" — accept both. */
function num(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const n = parseFloat(v.replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function blocked(rec, side) {
  const b = rec?.[side]?.blockedBy;
  return Array.isArray(b) ? b.length > 0 : true;
}

/**
 * Fold one day's tick records into the counts worth comparing across days.
 *
 * Stale ticks never reach the JSONL, so every record here is a real
 * observation; no filtering is needed and none is done.
 */
export function summariseDay(records) {
  const recs = (records || []).filter(r => r && typeof r === 'object');
  const ks = recs.map(r => num(r.stochastic?.k)).filter(v => v !== null);
  const dists = recs
    .map(r => num(r.higher_timeframe?.distance_atr))
    .filter(v => v !== null);

  const out = {
    ticks: recs.length,
    stoch: {
      min: ks.length ? Math.min(...ks) : null,
      max: ks.length ? Math.max(...ks) : null,
      median: median(ks),
      // The two thresholds the momentum trigger actually uses. A day that never
      // reaches either cannot produce a crossing, whatever the filters say.
      reached_overbought: ks.some(k => k >= 80),
      reached_oversold: ks.some(k => k <= 20),
    },
    ema_distance_atr: { median: median(dists) },
    sides: {},
  };

  for (const side of SIDES) {
    const open = recs.filter(r => !blocked(r, side));
    const crossings = recs.filter(r => r?.[side]?.triggers?.momentum_cross === 'met');
    const signals = recs.filter(r =>
      !blocked(r, side)
      && r?.[side]?.triggers?.momentum_cross === 'met'
      && r?.[side]?.triggers?.structure === 'met');
    out.sides[side] = {
      filters_open: open.length,
      filters_open_pct: recs.length ? Math.round(open.length / recs.length * 100) : 0,
      crossings: crossings.length,
      signals: signals.length,
      // The case the whole exercise is about: the side was authorised for a
      // meaningful part of the day and the trigger never came.
      open_but_never_triggered: open.length > 0 && crossings.length === 0,
    };
  }

  return out;
}

/** One compact line per day, for scanning a month at a glance. */
export function formatDayLine(date, s) {
  const n = (v, d = 0) => (v === null || v === undefined ? '—' : v.toFixed(d));
  const side = k => {
    const x = s.sides[k];
    return `${String(x.filters_open_pct).padStart(3)}% ${String(x.crossings).padStart(2)}x ${x.signals}s`;
  };
  return `${date}  ${String(s.ticks).padStart(3)}t`
    + `  K ${n(s.stoch.min, 1).padStart(5)}–${n(s.stoch.max, 1).padEnd(5)}`
    + `  ${s.stoch.reached_overbought ? 'OB' : '..'}${s.stoch.reached_oversold ? 'OS' : '..'}`
    + `  |EMA| ${n(s.ema_distance_atr.median, 2).padStart(5)}xATR`
    + `  haussier ${side('bullish')}  baissier ${side('bearish')}`;
}
