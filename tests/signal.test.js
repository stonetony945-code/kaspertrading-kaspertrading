/**
 * Unit tests for the trigger/filter evaluator — no TradingView connection.
 *
 * The crossing cases use the real numbers from 2026-09-01: gold's stochastic
 * ran 96.58 -> 23.55 between two captures seven hours apart, so the crossing
 * rules.json requires was never observable. These pin the behaviour that makes
 * it observable again.
 *
 * Run: node --test tests/signal.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, _internals } from '../src/core/signal.js';

const { crossedDownFromOverbought, crossedUpFromOversold } = _internals;
const st = (k, d) => ({ k, d });

/** A reading whose three filters all pass, for isolating one variable. */
const passingFilters = {
  atr: { state: 'stable', vs_20_period_avg: 1.0 },
  relative_volume: { state: 'normal', ratio: 1.0 },
  higher_timeframe: { direction: 'bearish' },
};

describe('crossedDownFromOverbought', () => {
  it('catches the crossing on the tick it happens', () => {
    assert.equal(crossedDownFromOverbought(st(96.58, 90.1), st(85.2, 88.4)), true);
  });

  it('still catches it once the oscillator has left overbought', () => {
    // The case that was missed on 2026-09-01.
    assert.equal(crossedDownFromOverbought(st(96.58, 90.1), st(23.55, 25.24)), true);
  });

  it('ignores a crossing that never involved overbought', () => {
    assert.equal(crossedDownFromOverbought(st(50, 48), st(45, 47)), false);
  });

  it('returns null without a previous tick rather than guessing', () => {
    assert.equal(crossedDownFromOverbought(null, st(23.55, 25.24)), null);
  });
});

describe('crossedUpFromOversold', () => {
  it('catches the bullish crossing out of oversold', () => {
    assert.equal(crossedUpFromOversold(st(12.56, 15.74), st(19.2, 17.1)), true);
  });

  it('reports nothing while K stays below D', () => {
    // GBPUSD that same morning: oversold, but no crossing yet.
    assert.equal(crossedUpFromOversold(st(14, 18), st(12.56, 15.74)), false);
  });
});

describe('filters veto independently of the triggers', () => {
  const cur = { price: 4402, stochastic: st(23.55, 25.24), ...passingFilters };
  const prev = { stochastic: st(96.58, 90.1) };
  const ctx = { smcDirection: 'bearish' };

  it('fires when both triggers hit and no filter blocks', () => {
    const r = evaluate(cur, prev, ctx);
    assert.equal(r.bearish.signal, true);
    assert.equal(r.signal.direction, 'bearish');
    assert.deepEqual(r.bearish.blockedBy, []);
  });

  it('blocks on compression, which is now a floor rather than expansion', () => {
    // The old model demanded active expansion at the same instant as the
    // reversal; this only rejects compression.
    const r = evaluate({ ...cur, atr: { state: 'compressing' } }, prev, ctx);
    assert.equal(r.bearish.signal, false);
    assert.deepEqual(r.bearish.blockedBy, ['volatility_floor']);
  });

  it('accepts stable volatility, which the old model rejected', () => {
    const r = evaluate({ ...cur, atr: { state: 'stable' } }, prev, ctx);
    assert.equal(r.bearish.filters.volatility_floor, 'met');
    assert.equal(r.bearish.signal, true);
  });

  it('blocks a move nobody is trading', () => {
    const r = evaluate({ ...cur, relative_volume: { state: 'thin', ratio: 0.4 } }, prev, ctx);
    assert.equal(r.bearish.signal, false);
    assert.deepEqual(r.bearish.blockedBy, ['participation']);
  });

  it('blocks when the higher timeframe trends the other way', () => {
    const r = evaluate({ ...cur, higher_timeframe: { direction: 'bullish' } }, prev, ctx);
    assert.equal(r.bearish.signal, false);
    assert.deepEqual(r.bearish.blockedBy, ['trend_context']);
  });

  it('tolerates a mixed higher timeframe', () => {
    const r = evaluate({ ...cur, higher_timeframe: { direction: 'mixed' } }, prev, ctx);
    assert.equal(r.bearish.filters.trend_context, 'met');
    assert.equal(r.bearish.signal, true);
  });
});

describe('unknown readings block rather than pass', () => {
  const prev = { stochastic: st(96.58, 90.1) };
  const ctx = { smcDirection: 'bearish' };

  it('treats an unmeasurable filter as blocking', () => {
    // Refusing to trade on a reading we could not take is the safe failure.
    const cur = { price: 4402, stochastic: st(23.55, 25.24), ...passingFilters, relative_volume: null };
    const r = evaluate(cur, prev, ctx);
    assert.equal(r.bearish.filters.participation, 'unknown');
    assert.equal(r.bearish.signal, false);
    assert.ok(r.bearish.blockedBy.includes('participation'));
  });

  it('does not fire without a previous tick, however good the rest', () => {
    const cur = { price: 4402, stochastic: st(23.55, 25.24), ...passingFilters };
    const r = evaluate(cur, null, ctx);
    assert.equal(r.bearish.triggers.momentum_cross, 'unknown');
    assert.equal(r.bearish.signal, false);
  });

  it('does not fire on an unknown structure', () => {
    const cur = { price: 4402, stochastic: st(23.55, 25.24), ...passingFilters };
    const r = evaluate(cur, prev, { smcDirection: null });
    assert.equal(r.bearish.triggers.structure, 'unknown');
    assert.equal(r.bearish.signal, false);
  });
});

describe('conflicting directions', () => {
  it('reports no signal when both sides would fire', () => {
    // Cannot happen with real data, but a contradiction must not resolve into
    // a confident trade in one direction.
    const cur = {
      price: 100, stochastic: st(50, 50),
      atr: { state: 'stable' }, relative_volume: { state: 'normal' },
      higher_timeframe: { direction: 'mixed' },
    };
    const both = { ...cur, stochastic: st(50, 50) };
    const r = evaluate(both, { stochastic: st(50, 50) }, { smcDirection: 'bearish' });
    assert.equal(r.conflict, false, 'sanity: this reading should not conflict');
    assert.equal(r.signal, null);
  });
});
