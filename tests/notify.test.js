/**
 * Unit tests for alert delivery — no network, no credentials.
 *
 * Run: node --test tests/notify.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { telegramConfigured, sendTelegram, formatSignal } from '../src/core/notify.js';

describe('telegramConfigured', () => {
  it('needs both values', () => {
    assert.equal(telegramConfigured({ TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: '1' }), true);
    assert.equal(telegramConfigured({ TELEGRAM_BOT_TOKEN: 't' }), false);
    assert.equal(telegramConfigured({ TELEGRAM_CHAT_ID: '1' }), false);
    assert.equal(telegramConfigured({}), false);
  });
});

describe('sendTelegram', () => {
  it('reports missing configuration instead of throwing', async () => {
    // Absence is a state, not a fault: the monitor runs fine without Telegram.
    const r = await sendTelegram('x', { env: {} });
    assert.deepEqual(r, { ok: false, reason: 'not_configured' });
  });

  it('never throws, so a delivery failure cannot stop the polling loop', async () => {
    const r = await sendTelegram('x', {
      env: { TELEGRAM_BOT_TOKEN: 'invalid', TELEGRAM_CHAT_ID: '0' },
      timeoutMs: 1,
    });
    assert.equal(r.ok, false);
    assert.ok(typeof r.reason === 'string');
  });
});

describe('formatSignal', () => {
  const base = {
    symbol: 'GBPUSD', direction: 'bearish', price: 1.35009,
    stochastic: { k: 77.19, d: 79.92 },
    atr: { state: 'expanding', vs_20_period_avg: 1.3 },
    volume: { ratio: 1.59, state: 'high' },
    htf: { direction: 'bearish' },
  };

  it('names the side in plain terms', () => {
    assert.match(formatSignal(base), /SIGNAL VENTE — GBPUSD/);
    assert.match(formatSignal({ ...base, direction: 'bullish' }), /SIGNAL ACHAT/);
  });

  it('carries the numbers that justify the signal', () => {
    const t = formatSignal(base);
    assert.match(t, /1\.35009/);
    assert.match(t, /K 77\.19 \/ D 79\.92/);
    assert.match(t, /ATR expanding x1\.3/);
    assert.match(t, /volume x1\.59 high/);
  });

  it('always states that it is not a recommendation', () => {
    // The whole point of pushing to a phone is that it arrives away from the
    // chart, so the caveat has to travel with it.
    assert.match(formatSignal(base), /pas une recommandation/);
  });

  it('includes levels only when given', () => {
    assert.doesNotMatch(formatSignal(base), /stop/);
    assert.match(formatSignal({ ...base, stop: 1.35185, target: 1.34657 }), /stop 1\.35185 · objectif 1\.34657/);
  });

  it('escapes HTML so a symbol cannot break the markup', () => {
    const t = formatSignal({ ...base, symbol: 'A<b>&' });
    assert.match(t, /A&lt;b&gt;&amp;/);
  });
});
