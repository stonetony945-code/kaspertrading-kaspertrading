import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { summariseDay, formatDayLine } from '../src/core/day-stats.js';

/** One tick, shaped like the monitor's JSONL records. */
const tick = ({ k = 50, bullBlocked = [], bearBlocked = [], bullCross = 'unmet', bearCross = 'unmet', bullStruct = 'unmet', bearStruct = 'unmet', dist = 1.0 } = {}) => ({
  stochastic: { k, d: k },
  higher_timeframe: { distance_atr: dist },
  bullish: { blockedBy: bullBlocked, triggers: { momentum_cross: bullCross, structure: bullStruct } },
  bearish: { blockedBy: bearBlocked, triggers: { momentum_cross: bearCross, structure: bearStruct } },
});

describe('summariseDay', () => {
  test('counts the day that prompted this: filters open, no crossing', () => {
    // 2026-09-10: bearish filters open on 53 of 54 ticks, stochastic peaked at
    // 68.5, price fell 69 pips in that direction, zero signals.
    const recs = [
      ...Array.from({ length: 53 }, (_, i) => tick({ k: 5 + i % 60, bearBlocked: [] })),
      tick({ k: 40, bearBlocked: ['participation'] }),
    ];
    const s = summariseDay(recs);
    assert.equal(s.ticks, 54);
    assert.equal(s.sides.bearish.filters_open, 53);
    assert.equal(s.sides.bearish.filters_open_pct, 98);
    assert.equal(s.sides.bearish.crossings, 0);
    assert.equal(s.sides.bearish.signals, 0);
    assert.equal(s.sides.bearish.open_but_never_triggered, true);
  });

  test('flags a day where the stochastic never reached overbought', () => {
    const recs = Array.from({ length: 20 }, (_, i) => tick({ k: 10 + i * 2 }));  // 10..48
    const s = summariseDay(recs);
    assert.equal(s.stoch.max, 48);
    assert.equal(s.stoch.reached_overbought, false, 'no sell can fire on such a day');
    assert.equal(s.stoch.reached_oversold, true);
  });

  test('a signal needs the filters open, the structure and the crossing', () => {
    const recs = [
      tick({ bearBlocked: [], bearCross: 'met', bearStruct: 'met' }),   // signal
      tick({ bearBlocked: [], bearCross: 'met', bearStruct: 'unmet' }), // no structure
      tick({ bearBlocked: ['participation'], bearCross: 'met', bearStruct: 'met' }), // blocked
    ];
    const s = summariseDay(recs);
    assert.equal(s.sides.bearish.crossings, 3, 'all three crossed');
    assert.equal(s.sides.bearish.signals, 1, 'only one was a signal');
  });

  test('open_but_never_triggered is false once a crossing happened', () => {
    const s = summariseDay([tick({ bearBlocked: [], bearCross: 'met' })]);
    assert.equal(s.sides.bearish.open_but_never_triggered, false);
  });

  test('a missing blockedBy counts as blocked, never as open', () => {
    // Absent evidence must not read as an authorised side -- the same rule the
    // signal evaluator applies to unknown verdicts.
    const s = summariseDay([{ stochastic: { k: 50 }, bullish: {}, bearish: {} }]);
    assert.equal(s.sides.bullish.filters_open, 0);
    assert.equal(s.sides.bearish.filters_open, 0);
  });

  test('reads numbers written with a comma decimal separator', () => {
    const s = summariseDay([{ stochastic: { k: '12,34' }, higher_timeframe: { distance_atr: '1,88' } }]);
    assert.equal(s.stoch.max, 12.34);
    assert.equal(s.ema_distance_atr.median, 1.88);
  });

  test('survives an empty or junk day without throwing', () => {
    const s = summariseDay([]);
    assert.equal(s.ticks, 0);
    assert.equal(s.stoch.max, null);
    assert.equal(s.sides.bearish.filters_open_pct, 0);
    assert.equal(summariseDay(null).ticks, 0);
    assert.equal(summariseDay([null, undefined, 3]).ticks, 0);
  });

  test('median of an even-length series averages the middle pair', () => {
    const s = summariseDay([tick({ k: 10 }), tick({ k: 20 }), tick({ k: 30 }), tick({ k: 40 })]);
    assert.equal(s.stoch.median, 25);
  });
});

describe('formatDayLine', () => {
  test('shows the date, the range and both sides', () => {
    const s = summariseDay([tick({ k: 5, bearBlocked: [] }), tick({ k: 68.5, bearBlocked: [] })]);
    const line = formatDayLine('2026-09-10', s);
    assert.match(line, /2026-09-10/);
    assert.match(line, /68\.5/);
    assert.match(line, /haussier/);
    assert.match(line, /baissier/);
  });

  test('marks a day that never reached overbought', () => {
    const s = summariseDay([tick({ k: 30 }), tick({ k: 68 })]);
    assert.ok(formatDayLine('2026-09-10', s).includes('..'), 'no OB marker');
  });
});
