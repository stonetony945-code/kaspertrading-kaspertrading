/**
 * Unit tests for the bias-criteria evaluator — no TradingView connection needed.
 *
 * The crossing tests use the real numbers from 2026-09-01: gold's stochastic
 * ran 96.58 -> 23.55 between two captures seven hours apart, so the crossing
 * that rules.json requires was never observable. These pin the behaviour that
 * makes it observable again.
 *
 * Run: node --test tests/signal.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, _internals } from '../src/core/signal.js';

const { crossedDownFromOverbought, crossedUpFromOversold } = _internals;
const st = (k, d) => ({ k, d });

describe('crossedDownFromOverbought', () => {
  it('catches the crossing on the tick it happens', () => {
    assert.equal(crossedDownFromOverbought(st(96.58, 90.1), st(85.2, 88.4)), true);
  });

  it('still catches it when the oscillator has already left overbought', () => {
    // The case that was missed: K was overbought last tick and has since
    // collapsed. The crossing is real and must not be discarded.
    assert.equal(crossedDownFromOverbought(st(96.58, 90.1), st(23.55, 25.24)), true);
  });

  it('ignores a crossing that never involved overbought', () => {
    assert.equal(crossedDownFromOverbought(st(50, 48), st(45, 47)), false);
  });

  it('reports nothing while K stays above D', () => {
    assert.equal(crossedDownFromOverbought(st(96, 90), st(94, 91)), false);
  });

  it('returns null without a previous tick, rather than guessing', () => {
    assert.equal(crossedDownFromOverbought(null, st(23.55, 25.24)), null);
    assert.equal(crossedDownFromOverbought(st(null, null), st(23, 25)), null);
  });
});

describe('crossedUpFromOversold', () => {
  it('catches the bullish crossing out of oversold', () => {
    assert.equal(crossedUpFromOversold(st(12.56, 15.74), st(19.2, 17.1)), true);
  });

  it('ignores a crossing in mid-range', () => {
    assert.equal(crossedUpFromOversold(st(50, 52), st(55, 53)), false);
  });

  it('reports nothing while K stays below D', () => {
    // GBPUSD on the morning of 2026-09-01: oversold, but K under D — no signal.
    assert.equal(crossedUpFromOversold(st(14, 18), st(12.56, 15.74)), false);
  });
});

describe('evaluate', () => {
  const bearishNow = {
    price: 4402.86,
    stochastic: st(23.55, 25.24),
    atr: { state: 'expanding', vs_20_period_avg: 1.18 },
    fair_value_gaps: { nearest: [{ side: 'above' }, { side: 'above' }] },
    volume_profile: { price_vs_value: 'below' },
  };
  const bearishPrev = { stochastic: st(96.58, 90.1) };
  const ctx = { signalMa: 4444.821, smcDirection: 'bearish' };

  it('fires when every criterion lines up', () => {
    const r = evaluate(bearishNow, bearishPrev, ctx);
    assert.equal(r.bearish.score, 5);
    assert.equal(r.bearish.signal, true);
    assert.equal(r.signal.direction, 'bearish');
  });

  it('withholds the signal when ATR is not expanding', () => {
    // rules.json singles ATR expansion out as validating the move, so a
    // four-of-five setup without it must not read as a setup.
    const cur = { ...bearishNow, atr: { state: 'compressing', vs_20_period_avg: 0.82 } };
    const r = evaluate(cur, bearishPrev, ctx);
    assert.equal(r.bearish.score, 4);
    assert.equal(r.bearish.signal, false);
    assert.equal(r.signal, null);
  });

  it('withholds the signal without the crossing, however good the rest', () => {
    const r = evaluate(bearishNow, null, ctx); // no previous tick
    assert.equal(r.bearish.criteria.stochastic_cross, 'unknown');
    assert.equal(r.bearish.signal, false);
  });

  it('counts an unmeasurable criterion as unknown, never as met', () => {
    const r = evaluate(bearishNow, bearishPrev, { signalMa: null, smcDirection: null });
    assert.equal(r.bearish.criteria.price_vs_ma, 'unknown');
    assert.equal(r.bearish.criteria.smc_structure, 'unknown');
    assert.equal(r.bearish.unknown, 2);
    assert.ok(r.bearish.score < 4, 'unknowns must not inflate the score');
  });

  it('does not report both directions at once', () => {
    const r = evaluate(bearishNow, bearishPrev, ctx);
    assert.equal(r.bullish.signal, false);
  });

  it('reproduces the GBPUSD reading of 2026-09-01 as no signal', () => {
    // Oversold but K still under D, ATR stable at x1.12: a near miss, and the
    // evaluator must say so rather than round it up.
    const cur = {
      price: 1.35315,
      stochastic: st(12.56, 15.74),
      atr: { state: 'stable', vs_20_period_avg: 1.12 },
      fair_value_gaps: { nearest: [{ side: 'above' }, { side: 'above' }] },
      volume_profile: { price_vs_value: 'inside' },
    };
    const r = evaluate(cur, { stochastic: st(97.11, 71.95) }, { signalMa: 1.35293, smcDirection: 'bearish' });
    assert.equal(r.signal, null);
    assert.equal(r.bearish.criteria.atr_expanding, 'unmet');
  });
});
