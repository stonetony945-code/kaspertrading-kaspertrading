import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  openPosition, updatePosition, catchUpPosition, expirePosition,
  excursions, unrealised, formatOutcome,
} from '../src/core/signal-tracker.js';

/** The real signal of 2026-09-07 12:16, entry 1.35296, ATR 4.72 pips. */
const long = () => openPosition({
  symbol: 'GBPUSD', direction: 'bullish',
  entry: 1.35296, stop: 1.35202, target: 1.35520, at: '2026-09-07T12:16:57.422Z',
});

const short = () => openPosition({
  symbol: 'GBPUSD', direction: 'bearish',
  entry: 1.35009, stop: 1.35185, target: 1.34657, at: '2026-09-02T13:50:00.000Z',
});

describe('openPosition', () => {
  test('starts with the extremes at the entry, unresolved', () => {
    const p = long();
    assert.equal(p.high, 1.35296);
    assert.equal(p.low, 1.35296);
    assert.equal(p.outcome, null);
    assert.equal(p.bars_seen, 0);
  });

  test('refuses a position without usable levels', () => {
    assert.throws(() => openPosition({
      symbol: 'GBPUSD', direction: 'bullish', entry: 1.353, stop: null, target: 1.355,
    }), /stop/);
  });
});

describe('updatePosition — long', () => {
  test('tracks extremes without resolving inside the range', () => {
    let p = long();
    p = updatePosition(p, { high: 1.35400, low: 1.35292 });
    assert.equal(p.outcome, null);
    assert.equal(p.high, 1.35400);
    assert.equal(p.low, 1.35292);
    assert.equal(p.bars_seen, 1);
  });

  test('resolves on the target', () => {
    let p = long();
    p = updatePosition(p, { high: 1.35525, low: 1.35400 });
    assert.equal(p.outcome, 'target');
    assert.ok(p.resolved_at);
  });

  test('resolves on the stop', () => {
    let p = long();
    p = updatePosition(p, { high: 1.35300, low: 1.35200 });
    assert.equal(p.outcome, 'stop');
  });

  test('a bar touching both is reported as both, never guessed', () => {
    // 15-minute bars carry no intrabar order. Calling this a win would be
    // inventing the favourable half of an ambiguity.
    let p = long();
    p = updatePosition(p, { high: 1.35530, low: 1.35190 });
    assert.equal(p.outcome, 'both');
  });

  test('a resolved position is never reopened by later bars', () => {
    let p = long();
    p = updatePosition(p, { high: 1.35525, low: 1.35400 });
    const after = updatePosition(p, { high: 1.36000, low: 1.35000 });
    assert.equal(after.outcome, 'target');
    assert.equal(after.high, p.high);
  });

  test('does not mutate its input', () => {
    const p = long();
    updatePosition(p, { high: 1.36, low: 1.34 });
    assert.equal(p.high, 1.35296);
    assert.equal(p.outcome, null);
  });
});

describe('updatePosition — short', () => {
  test('the stop is above and the target below', () => {
    let p = short();
    p = updatePosition(p, { high: 1.35190, low: 1.35000 });
    assert.equal(p.outcome, 'stop');

    let q = short();
    q = updatePosition(q, { high: 1.35050, low: 1.34650 });
    assert.equal(q.outcome, 'target');
  });
});

describe('catchUpPosition', () => {
  const bar = (time, high, low) => ({ time, high, low });

  test('replays the bars missed while the monitor was down', () => {
    // The real failure: the monitor lost 634 minutes on the night of
    // 2026-09-07 while price reached 1.35529, clearing a target at 1.35485.
    // Folding only the newest bar on waking would never have seen it.
    const p = openPosition({
      symbol: 'GBPUSD', direction: 'bullish',
      entry: 1.35296, stop: 1.35202, target: 1.35485, barTime: 1000,
    });
    const overnight = [
      bar(1900, 1.35400, 1.35300),
      bar(2800, 1.35529, 1.35420),   // the bar that cleared the target
      bar(3700, 1.35340, 1.35263),
    ];
    const after = catchUpPosition(p, overnight);
    assert.equal(after.outcome, 'target');
    assert.equal(after.high, 1.35529);
  });

  test('stops at the bar that resolved it, not the newest', () => {
    const p = openPosition({
      symbol: 'GBPUSD', direction: 'bullish',
      entry: 1.353, stop: 1.352, target: 1.354, barTime: 1000,
    });
    const after = catchUpPosition(p, [
      bar(1900, 1.3541, 1.3530),   // target
      bar(2800, 1.3600, 1.3500),   // later, wilder — must not count
    ]);
    assert.equal(after.outcome, 'target');
    assert.equal(after.high, 1.3541);
    assert.equal(after.last_bar_time, 1900);
  });

  test('skips bars at or before the entry bar', () => {
    // The entry bar's range includes prices from before the signal fired.
    const p = openPosition({
      symbol: 'GBPUSD', direction: 'bullish',
      entry: 1.353, stop: 1.352, target: 1.354, barTime: 2000,
    });
    const after = catchUpPosition(p, [
      bar(1000, 1.3600, 1.3500),   // long before entry
      bar(2000, 1.3545, 1.3510),   // the entry bar itself
    ]);
    assert.equal(after.outcome, null);
    assert.equal(after.bars_seen, 0);
  });

  test('does not re-count bars already folded in', () => {
    const p = openPosition({
      symbol: 'GBPUSD', direction: 'bullish',
      entry: 1.353, stop: 1.352, target: 1.360, barTime: 1000,
    });
    const bars = [bar(1900, 1.3540, 1.3525), bar(2800, 1.3550, 1.3535)];
    const once = catchUpPosition(p, bars);
    const twice = catchUpPosition(once, bars);
    assert.equal(once.bars_seen, 2);
    assert.equal(twice.bars_seen, 2);
  });

  test('a position with no bar time yet folds everything it is given', () => {
    const p = openPosition({
      symbol: 'GBPUSD', direction: 'bullish',
      entry: 1.353, stop: 1.352, target: 1.360,
    });
    const after = catchUpPosition(p, [bar(1900, 1.3555, 1.3528)]);
    assert.equal(after.bars_seen, 1);
    assert.equal(after.high, 1.3555);
  });
});

describe('excursions', () => {
  test('favourable is positive for a long that went up', () => {
    let p = long();
    p = updatePosition(p, { high: 1.35477, low: 1.35292 });
    const { mfe, mae } = excursions(p);
    assert.equal(Number(mfe.toFixed(1)), 18.1);
    assert.equal(Number(mae.toFixed(1)), 0.4);
  });

  test('favourable is positive for a short that went down', () => {
    let p = short();
    p = updatePosition(p, { high: 1.35050, low: 1.34800 });
    const { mfe, mae } = excursions(p);
    assert.equal(Number(mfe.toFixed(1)), 20.9);
    assert.equal(Number(mae.toFixed(1)), 4.1);
  });

  test('gold counts in points, not pips', () => {
    const p = openPosition({
      symbol: 'XAUUSD', direction: 'bullish', entry: 2000, stop: 1990, target: 2020,
    });
    const moved = updatePosition(p, { high: 2008, low: 1999 });
    const { mfe, mae } = excursions(moved, 1);
    assert.equal(mfe, 8);
    assert.equal(mae, 1);
  });
});

describe('unrealised', () => {
  test('is signed from the trade point of view', () => {
    assert.equal(Number(unrealised(long(), 1.35422).toFixed(1)), 12.6);
    assert.equal(Number(unrealised(short(), 1.35109).toFixed(1)), -10.0);
  });
});

describe('expirePosition', () => {
  test('closes an open position with the given reason', () => {
    const p = expirePosition(long(), 'market_closed');
    assert.equal(p.outcome, 'market_closed');
    assert.ok(p.resolved_at);
  });

  test('leaves a resolved one alone', () => {
    let p = updatePosition(long(), { high: 1.35525, low: 1.354 });
    p = expirePosition(p, 'market_closed');
    assert.equal(p.outcome, 'target');
  });
});

describe('formatOutcome', () => {
  test('restates the levels, for a reader who no longer has the alert', () => {
    let p = updatePosition(long(), { high: 1.35525, low: 1.35292 });
    const text = formatOutcome(p, { price: 1.35520 });
    assert.match(text, /OBJECTIF ATTEINT/);
    assert.match(text, /ACHAT GBPUSD/);
    assert.match(text, /1\.35296/);   // entry
    assert.match(text, /1\.35202/);   // stop
    assert.match(text, /1\.35520/);   // target
  });

  test('says plainly that an ambiguous bar is undetermined', () => {
    const p = updatePosition(long(), { high: 1.35530, low: 1.35190 });
    assert.match(formatOutcome(p), /indetermine/);
  });

  test('carries the reminder that nothing was actually traded', () => {
    const p = expirePosition(long());
    assert.match(formatOutcome(p), /aucune position/i);
  });
});
