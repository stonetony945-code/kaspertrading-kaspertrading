/**
 * Unit tests for OHLCV-derived indicators — no TradingView connection needed.
 *
 * Expected values are computed by hand in the comments so the assertions are
 * checkable independently of the implementation.
 *
 * Run: node --test tests/indicators.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { stochastic, atr, fairValueGaps, volumeProfile, inferDecimals, summarise } from '../src/core/derived-indicators.js';

const bar = (high, low, close, volume = 100, time = 0) => ({ high, low, close, volume, time, open: close });

function assertClose(actual, expected, tolerance = 1e-9, msg = '') {
  assert.ok(
    actual !== null && Math.abs(actual - expected) < tolerance,
    `${msg} expected ~${expected}, got ${actual}`
  );
}

describe('stochastic', () => {
  // periodK=3, smoothK=1, periodD=2
  //   bars: (h,l,c) = (10,8,9) (12,9,11) (14,10,13) (13,11,12)
  //   i=2: hh=14 ll=8  c=13 -> (13-8)/(14-8)*100 = 83.333...
  //   i=3: hh=14 ll=9  c=12 -> (12-9)/(14-9)*100 = 60
  //   %D at i=3 = (83.333... + 60) / 2 = 71.666...
  const bars = [bar(10, 8, 9), bar(12, 9, 11), bar(14, 10, 13), bar(13, 11, 12)];

  it('computes %K from the high/low window', () => {
    const { k } = stochastic(bars, { periodK: 3, smoothK: 1, periodD: 2 });
    assertClose(k[2], 500 / 6, 1e-9, '%K at index 2');
    assertClose(k[3], 60, 1e-9, '%K at index 3');
  });

  it('computes %D as the SMA of %K', () => {
    const { d, lastD } = stochastic(bars, { periodK: 3, smoothK: 1, periodD: 2 });
    assertClose(d[3], (500 / 6 + 60) / 2, 1e-9, '%D at index 3');
    assertClose(lastD, (500 / 6 + 60) / 2, 1e-9, 'lastD');
  });

  it('null-pads until the window is full', () => {
    const { k, d } = stochastic(bars, { periodK: 3, smoothK: 1, periodD: 2 });
    assert.equal(k[0], null);
    assert.equal(k[1], null);
    assert.equal(d[2], null, '%D needs two %K values');
  });

  it('stays within 0..100 and hits the bounds exactly', () => {
    // close at the window high -> 100 ; close at the window low -> 0
    const atHigh = [bar(10, 8, 9), bar(12, 9, 11), bar(14, 10, 14)];
    const atLow = [bar(10, 8, 9), bar(12, 9, 11), bar(14, 8, 8)];
    assertClose(stochastic(atHigh, { periodK: 3 }).lastK, 100, 1e-9, 'close at high');
    assertClose(stochastic(atLow, { periodK: 3 }).lastK, 0, 1e-9, 'close at low');
  });

  it('returns null rather than a fabricated value on a zero-range window', () => {
    const flat = [bar(5, 5, 5), bar(5, 5, 5), bar(5, 5, 5)];
    assert.equal(stochastic(flat, { periodK: 3 }).lastK, null);
  });
});

describe('atr', () => {
  // period=2
  //   bar0 (10,8,9)   -> TR = 10-8 = 2                     (no previous close)
  //   bar1 (12,9,11)  -> TR = max(3, |12-9|=3, |9-9|=0) = 3
  //   bar2 (14,10,13) -> TR = max(4, |14-11|=3, |10-11|=1) = 4
  //   RMA seed at i=1 = (2+3)/2 = 2.5
  //   RMA at i=2      = (2.5*1 + 4)/2 = 3.25
  const bars = [bar(10, 8, 9), bar(12, 9, 11), bar(14, 10, 13)];

  it('computes true range including the previous close', () => {
    const { tr } = atr(bars, { period: 2 });
    assert.deepEqual(tr, [2, 3, 4]);
  });

  it('smooths with Wilder RMA, not a plain SMA', () => {
    const { atr: series, last } = atr(bars, { period: 2 });
    assertClose(series[1], 2.5, 1e-9, 'RMA seed');
    assertClose(series[2], 3.25, 1e-9, 'RMA step');
    assertClose(last, 3.25, 1e-9, 'last');
    // A plain SMA of the last 2 TRs would be (3+4)/2 = 3.5 — must differ.
    assert.notEqual(Math.round(last * 100), 350);
  });

  it('null-pads before the seed', () => {
    assert.equal(atr(bars, { period: 2 }).atr[0], null);
  });
});

describe('fairValueGaps', () => {
  it('detects a bullish gap when bar i clears bar i-2', () => {
    // high[0]=10, low[2]=12 -> unfilled bullish gap spanning 10..12
    const bars = [bar(10, 8, 9), bar(11, 9, 10), bar(15, 12, 14)];
    const gaps = fairValueGaps(bars);
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0].type, 'bullish');
    assert.equal(gaps[0].bottom, 10);
    assert.equal(gaps[0].top, 12);
    assert.equal(gaps[0].filled, false);
    assert.equal(gaps[0].size, 2);
  });

  it('detects a bearish gap', () => {
    // low[0]=12, high[2]=9 -> bearish gap spanning 9..12
    const bars = [bar(15, 12, 14), bar(13, 10, 11), bar(9, 7, 8)];
    const gaps = fairValueGaps(bars);
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0].type, 'bearish');
    assert.equal(gaps[0].bottom, 9);
    assert.equal(gaps[0].top, 12);
  });

  it('marks a gap filled once price trades back into it', () => {
    const bars = [bar(10, 8, 9), bar(11, 9, 10), bar(15, 12, 14), bar(13, 9, 10)];
    assert.equal(fairValueGaps(bars, { includeFilled: true })[0].filled, true);
    assert.equal(fairValueGaps(bars).length, 0, 'filled gaps hidden by default');
  });

  it('reports nothing when bars overlap', () => {
    const bars = [bar(10, 8, 9), bar(11, 9, 10), bar(11, 9, 10)];
    assert.equal(fairValueGaps(bars).length, 0);
  });
});

describe('volumeProfile', () => {
  it('puts the POC where volume is concentrated', () => {
    // Heavy volume parked at 10-11, light volume out at 18-20.
    const bars = [
      bar(11, 10, 10.5, 1000), bar(11, 10, 10.5, 1000), bar(11, 10, 10.5, 1000),
      bar(20, 18, 19, 10),
    ];
    const vp = volumeProfile(bars, { bins: 10 });
    assert.ok(vp.poc >= 10 && vp.poc <= 11.5, `POC ${vp.poc} should sit in the heavy zone`);
  });

  it('brackets the POC with the value area', () => {
    const bars = Array.from({ length: 20 }, (_, i) => bar(12 + (i % 3), 10 + (i % 3), 11 + (i % 3), 100 + i));
    const vp = volumeProfile(bars, { bins: 12 });
    assert.ok(vp.valueAreaLow <= vp.poc, 'VAL <= POC');
    assert.ok(vp.valueAreaHigh >= vp.poc, 'VAH >= POC');
    assert.ok(vp.low <= vp.valueAreaLow && vp.valueAreaHigh <= vp.high, 'value area inside range');
  });

  it('flags itself as an approximation', () => {
    const bars = [bar(11, 10, 10.5, 100), bar(12, 11, 11.5, 100)];
    assert.equal(volumeProfile(bars).approximate, true);
  });

  it('returns null on a zero-range series', () => {
    assert.equal(volumeProfile([bar(5, 5, 5), bar(5, 5, 5)]), null);
  });
});

describe('inferDecimals', () => {
  it('reads forex precision from the bars', () => {
    const fx = [bar(1.35345, 1.3526, 1.35319), bar(1.35401, 1.35298, 1.35377)];
    assert.equal(inferDecimals(fx), 5);
  });

  it('reads metal precision from the bars', () => {
    const gold = [bar(4460.12, 4453.135, 4454.99), bar(4458.45, 4453.91, 4457.195)];
    assert.equal(inferDecimals(gold), 3);
  });

  it('never drops below 2 decimals', () => {
    assert.equal(inferDecimals([bar(10, 8, 9), bar(11, 9, 10)]), 2);
  });
});

describe('summarise', () => {
  // A 3-bar bullish gap on a forex-scale instrument: rounding to a fixed 2
  // decimals would collapse bottom and top onto the same number and report a
  // gap of size 0, which is what this guards against.
  // Values carry five real decimals: JS drops trailing zeros, so 1.35100 would
  // read back as 3-decimal precision and defeat the point of the test.
  const fxGap = [
    bar(1.35107, 1.35003, 1.35052),
    bar(1.35204, 1.35123, 1.35181),
    bar(1.35401, 1.35187, 1.35302),
  ];

  it('keeps forex gap levels distinct instead of collapsing them', () => {
    const out = summarise(fxGap, { include: new Set(['fvg']) });
    const g = out.fair_value_gaps.nearest[0];
    assert.equal(out.price_decimals, 5);
    assert.notEqual(g.bottom, g.top, 'bottom and top must not round together');
    assert.ok(g.size > 0, `gap size must survive rounding, got ${g.size}`);
    assert.equal(g.bottom, 1.35107);
    assert.equal(g.top, 1.35187);
  });

  it('returns only the requested sections', () => {
    const out = summarise(fxGap, { include: new Set(['fvg']) });
    assert.ok(out.fair_value_gaps);
    assert.equal(out.stochastic, undefined);
    assert.equal(out.atr, undefined);
    assert.equal(out.volume_profile, undefined);
  });

  it('flags stale data when the newest bar is hours old', () => {
    const old = Math.floor(Date.now() / 1000) - 44 * 3600;
    const bars = fxGap.map((b, i) => ({ ...b, time: old + i * 900 }));
    const out = summarise(bars, { include: new Set(['fvg']) });
    assert.equal(out.stale, true);
    assert.ok(out.stale_warning.includes('h old'), out.stale_warning);
    assert.ok(out.last_bar_age_minutes > 2600);
  });

  it('does not flag fresh data', () => {
    const now = Math.floor(Date.now() / 1000);
    const bars = fxGap.map((b, i) => ({ ...b, time: now - (2 - i) * 900 }));
    const out = summarise(bars, { include: new Set(['fvg']) });
    assert.equal(out.stale, undefined);
    assert.equal(out.stale_warning, undefined);
  });
});
