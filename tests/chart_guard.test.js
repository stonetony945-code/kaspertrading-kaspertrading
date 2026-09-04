import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  symbolMatches, resolutionMatches, awaitChart, describeMismatch,
} from '../src/core/chart-guard.js';

describe('symbolMatches', () => {
  test('accepts the exchange-qualified form of a bare ticker', () => {
    assert.equal(symbolMatches('FX:GBPUSD', 'GBPUSD'), true);
    assert.equal(symbolMatches('OANDA:XAUUSD', 'XAUUSD'), true);
  });

  test('accepts the reverse, for --no-switch where the watchlist is already qualified', () => {
    assert.equal(symbolMatches('GBPUSD', 'FX:GBPUSD'), true);
  });

  test('accepts an exact match', () => {
    assert.equal(symbolMatches('FX:GBPUSD', 'FX:GBPUSD'), true);
  });

  test('rejects a different instrument', () => {
    assert.equal(symbolMatches('FX:EURUSD', 'GBPUSD'), false);
    assert.equal(symbolMatches('SP:SPX', 'GBPUSD'), false);
  });

  test('requires the colon, so a longer ticker ending in the same letters does not match', () => {
    // The bug this whole module exists for filed index bars under GBPUSD.
    // A suffix test without the separator would let "XGBPUSD" through.
    assert.equal(symbolMatches('FX:XGBPUSD', 'GBPUSD'), false);
  });

  test('treats a missing state as no match rather than a match', () => {
    assert.equal(symbolMatches(null, 'GBPUSD'), false);
    assert.equal(symbolMatches(undefined, 'GBPUSD'), false);
    assert.equal(symbolMatches('FX:GBPUSD', null), false);
  });
});

describe('resolutionMatches', () => {
  test('compares as strings, so 15 and "15" agree', () => {
    assert.equal(resolutionMatches('15', 15), true);
    assert.equal(resolutionMatches(15, '15'), true);
  });

  test('rejects a different timeframe', () => {
    assert.equal(resolutionMatches('60', '15'), false);
  });

  test('a null request means the caller does not care', () => {
    assert.equal(resolutionMatches('60', null), true);
  });

  test('a missing state resolution never matches', () => {
    assert.equal(resolutionMatches(null, '15'), false);
    assert.equal(resolutionMatches(undefined, '15'), false);
  });
});

describe('awaitChart', () => {
  const noSleep = () => Promise.resolve();

  test('returns as soon as the chart already matches', async () => {
    let calls = 0;
    const getState = async () => { calls++; return { symbol: 'FX:GBPUSD', resolution: '15' }; };
    const st = await awaitChart({ symbol: 'GBPUSD', timeframe: '15', getState, sleep: noSleep });
    assert.equal(st.symbol, 'FX:GBPUSD');
    assert.equal(calls, 1);
  });

  test('polls until the switch lands', async () => {
    // The real failure: the chart still reports the previous symbol for a while
    // after setSymbol returns. The fixed sleep read straight through this.
    const states = [
      { symbol: 'SP:SPX', resolution: '15' },
      { symbol: 'SP:SPX', resolution: '15' },
      { symbol: 'FX:GBPUSD', resolution: '15' },
    ];
    let i = 0;
    const getState = async () => states[Math.min(i++, states.length - 1)];
    const st = await awaitChart({ symbol: 'GBPUSD', timeframe: '15', getState, sleep: noSleep });
    assert.equal(st.symbol, 'FX:GBPUSD');
    assert.equal(i, 3);
  });

  test('waits for the timeframe too, not only the symbol', async () => {
    const states = [
      { symbol: 'FX:GBPUSD', resolution: '60' },
      { symbol: 'FX:GBPUSD', resolution: '15' },
    ];
    let i = 0;
    const getState = async () => states[Math.min(i++, states.length - 1)];
    const st = await awaitChart({ symbol: 'GBPUSD', timeframe: '15', getState, sleep: noSleep });
    assert.equal(st.resolution, '15');
  });

  test('returns null when the chart never arrives', async () => {
    const getState = async () => ({ symbol: 'SP:SPX', resolution: '15' });
    const st = await awaitChart({
      symbol: 'GBPUSD', timeframe: '15', getState, sleep: noSleep, deadlineMs: 0,
    });
    assert.equal(st, null);
  });

  test('survives a getState that throws, and keeps polling', async () => {
    let i = 0;
    const getState = async () => {
      i++;
      if (i < 3) throw new Error('CDP timeout');
      return { symbol: 'FX:GBPUSD', resolution: '15' };
    };
    const st = await awaitChart({ symbol: 'GBPUSD', timeframe: '15', getState, sleep: noSleep });
    assert.equal(st.symbol, 'FX:GBPUSD');
  });
});

describe('describeMismatch', () => {
  test('names what was found and what was wanted', () => {
    const msg = describeMismatch({ symbol: 'SP:SPX', resolution: '15' }, 'GBPUSD', '15');
    assert.match(msg, /SP:SPX/);
    assert.match(msg, /GBPUSD/);
  });

  test('copes with an unreadable state', () => {
    assert.match(describeMismatch(null, 'GBPUSD', '15'), /illisible/);
  });
});
