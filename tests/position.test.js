/**
 * Unit tests for ATR-based stop and position sizing.
 *
 * The reference numbers are the live ATRs measured on 2026-09-01 and the
 * account in rules.json, so the assertions describe the user's real situation
 * rather than a convenient one.
 *
 * Run: node --test tests/position.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sizePosition, targetDistance, CONTRACT } from '../src/core/position.js';

const ACCOUNT = 94;
const ATR_CABLE = 0.000519; // GBPUSD, 15m, 2026-09-01
const ATR_GOLD = 10.15;     // XAUUSD, 15m, same session

describe('sizePosition — GBPUSD', () => {
  const r = sizePosition({
    atr: ATR_CABLE, account: ACCOUNT, riskPct: 0.02, atrMultiple: 2,
    contract: CONTRACT.GBPUSD,
  });

  it('sets the stop at the requested multiple of ATR', () => {
    assert.ok(Math.abs(r.stopDistance - 0.001038) < 1e-9);
    assert.ok(Math.abs(r.stopInLabel - 10.38) < 0.01, `${r.stopInLabel} pips`);
  });

  it('is tradable at the broker minimum', () => {
    assert.equal(r.tradable, true);
    assert.ok(r.lots >= 0.01);
  });

  it('keeps the risk inside the budget', () => {
    assert.ok(r.riskAmount <= r.budget + 1e-9, `${r.riskAmount} > ${r.budget}`);
    assert.ok(r.riskPctActual <= 0.02 + 1e-9);
  });

  it('never rounds lots up into a larger risk than asked', () => {
    // 0.01 lot costs 1.038; the 1.88 budget allows one step, not two.
    assert.equal(Number(r.lots.toFixed(2)), 0.01);
  });
});

describe('sizePosition — XAUUSD', () => {
  const r = sizePosition({
    atr: ATR_GOLD, account: ACCOUNT, riskPct: 0.02, atrMultiple: 2,
    contract: CONTRACT.XAUUSD,
  });

  it('finds the minimum lot already exceeds the risk budget', () => {
    // One ounce moving 20.3 dollars is 20.30 of risk on a 94 account: 21.6%,
    // against a 2% budget. No lot size fixes that, so it must be reported.
    assert.equal(r.tradable, false);
    assert.equal(r.lots, 0);
    assert.ok(r.minLotRiskPct > 0.2, `${r.minLotRiskPct}`);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /lot minimum/);
  });

  it('reports zero risk when no position can be taken', () => {
    assert.equal(r.riskAmount, 0);
  });

  it('still does not fit at 2% even with 0.001 lots', () => {
    // Worth pinning: micro lots are not the fix people assume. One thousandth
    // of a lot on a 20.3 dollar stop is 2.03, which is 2.16% of 94 -- over a
    // 2% budget, narrowly.
    const micro = sizePosition({
      atr: ATR_GOLD, account: ACCOUNT, riskPct: 0.02, atrMultiple: 2,
      contract: CONTRACT.XAUUSD, minLot: 0.001, lotStep: 0.001,
    });
    assert.equal(micro.tradable, false);
    assert.ok(Math.abs(micro.minLotRiskPct - 0.0216) < 0.0005, `${micro.minLotRiskPct}`);
  });

  it('fits at 0.001 lots once the budget is 2.5%', () => {
    const micro = sizePosition({
      atr: ATR_GOLD, account: ACCOUNT, riskPct: 0.025, atrMultiple: 2,
      contract: CONTRACT.XAUUSD, minLot: 0.001, lotStep: 0.001,
    });
    assert.equal(micro.tradable, true);
    assert.equal(Number(micro.lots.toFixed(3)), 0.001);
    assert.ok(micro.riskPctActual <= 0.025 + 1e-9);
  });
});

describe('sizePosition — guards', () => {
  it('refuses a non-positive ATR instead of dividing by it', () => {
    assert.throws(() => sizePosition({ atr: 0, account: 94, contract: CONTRACT.GBPUSD }), /atr/);
  });

  it('refuses a non-positive account', () => {
    assert.throws(() => sizePosition({ atr: 0.0005, account: 0, contract: CONTRACT.GBPUSD }), /account/);
  });

  it('scales the stop with the multiple', () => {
    const a = sizePosition({ atr: ATR_CABLE, account: ACCOUNT, atrMultiple: 1, contract: CONTRACT.GBPUSD });
    const b = sizePosition({ atr: ATR_CABLE, account: ACCOUNT, atrMultiple: 3, contract: CONTRACT.GBPUSD });
    assert.ok(Math.abs(b.stopDistance - a.stopDistance * 3) < 1e-12);
  });
});

describe('targetDistance', () => {
  it('applies the reward multiple to the stop', () => {
    assert.equal(targetDistance(0.001, 2), 0.002);
  });

  it('charges the spread before applying the multiple', () => {
    // rules.json asks for R:R net of spread: a 1 pip spread on a 10 pip stop
    // means the target must cover 11, not 10.
    assert.ok(Math.abs(targetDistance(0.0010, 2, 0.0001) - 0.0022) < 1e-12);
  });
});
