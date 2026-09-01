/**
 * Stop distance and position size derived from volatility.
 *
 * rules.json specified a flat "10-15 pips" stop for both instruments. Applied
 * literally that risks 1.6% of the account on GBPUSD and 16% on gold, because
 * one point of gold is worth ten times one pip of cable at the same lot size.
 * The same number also means very different things in market terms: 15 pips is
 * three times cable's ATR but barely 1.5 times gold's.
 *
 * Sizing off ATR fixes both at once -- the stop adapts to what the instrument
 * is actually doing, and the lot size falls out of the risk budget rather than
 * being assumed.
 */

/**
 * Value of a one-unit price move, per 1.0 lot, in account currency.
 * GBPUSD: 1 standard lot is 100 000 units, so a move of 1.00 is 100 000.
 * XAUUSD: 1 standard lot is 100 ounces, so a move of 1.00 (one dollar) is 100.
 * Confirm against your broker -- contract sizes are not universal.
 */
export const CONTRACT = {
  GBPUSD: { valuePerPricePointPerLot: 100000, pip: 0.0001, label: 'pips' },
  XAUUSD: { valuePerPricePointPerLot: 100, pip: 1, label: 'points' },
};

/**
 * @param {object} p
 * @param {number} p.atr          current ATR in price units
 * @param {number} p.account      account balance
 * @param {number} p.riskPct      fraction of the account to risk, e.g. 0.02
 * @param {number} p.atrMultiple  stop distance as a multiple of ATR
 * @param {object} p.contract     entry from CONTRACT
 * @param {number} p.minLot       broker minimum, e.g. 0.01
 * @param {number} p.lotStep      broker increment, e.g. 0.01
 */
export function sizePosition({
  atr, account, riskPct = 0.02, atrMultiple = 2,
  contract, minLot = 0.01, lotStep = 0.01,
}) {
  if (!(atr > 0)) throw new Error('atr doit etre positif');
  if (!(account > 0)) throw new Error('account doit etre positif');
  if (!contract) throw new Error('contract requis');

  const stopDistance = atr * atrMultiple;
  const budget = account * riskPct;
  const riskPerLot = stopDistance * contract.valuePerPricePointPerLot;

  // Round down to a tradable lot so the risk budget is never exceeded by
  // rounding, then check what the broker minimum actually costs.
  const rawLots = budget / riskPerLot;
  const steps = Math.floor(rawLots / lotStep);
  const lots = Math.max(0, steps * lotStep);

  const minLotRisk = riskPerLot * minLot;
  const warnings = [];

  let tradableLots = lots;
  if (lots < minLot) {
    // The smallest position the broker allows already costs more than the
    // budget. Report it rather than silently rounding up into it.
    tradableLots = 0;
    warnings.push(
      `Le lot minimum (${minLot}) risque ${minLotRisk.toFixed(2)} soit `
      + `${(minLotRisk / account * 100).toFixed(1)}% du compte, au-dela du budget de `
      + `${(riskPct * 100).toFixed(1)}%. Position non dimensionnable a ce risque.`
    );
  }

  const actualRisk = tradableLots * riskPerLot;

  return {
    stopDistance,
    stopInLabel: stopDistance / contract.pip,
    label: contract.label,
    budget,
    riskPerLot,
    lots: tradableLots,
    riskAmount: actualRisk,
    riskPctActual: account > 0 ? actualRisk / account : 0,
    minLotRisk,
    minLotRiskPct: minLotRisk / account,
    tradable: tradableLots >= minLot,
    warnings,
  };
}

/** Target distance for a given reward-to-risk, in price units. */
export function targetDistance(stopDistance, rr = 2, spread = 0) {
  // rules.json asks for R:R net of spread, so the spread is charged to the
  // stop side before the multiple is applied.
  return (stopDistance + spread) * rr;
}
