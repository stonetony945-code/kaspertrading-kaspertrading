#!/usr/bin/env node
/**
 * Reads the indicators that don't fit on the chart.
 *
 * TradingView's Basic plan allows 2 indicators per chart. Rather than fight
 * for slots, this computes Stochastic, ATR, Fair Value Gaps and a volume
 * profile from the chart's own OHLCV bars — no slot used, all at once.
 *
 * Usage:
 *   node scripts/missing-indicators.js            # 300 bars, text output
 *   node scripts/missing-indicators.js --json     # machine-readable
 *   node scripts/missing-indicators.js --bars 150
 *
 * Requires TradingView running with --remote-debugging-port=9222.
 */

import { getOhlcv } from '../src/core/data.js';
import { getState } from '../src/core/chart.js';
import { disconnect } from '../src/connection.js';
import { stochastic, atr, fairValueGaps, volumeProfile } from '../src/core/derived-indicators.js';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const barsIdx = args.indexOf('--bars');
const barCount = barsIdx !== -1 ? Number(args[barsIdx + 1]) : 300;

const round = (v, dp = 2) => (v === null || v === undefined ? null : Number(v.toFixed(dp)));

function classifyStoch(k, d) {
  if (k === null || d === null) return 'indisponible';
  if (k < 20) return k > d ? 'survente, croisement haussier' : 'survente';
  if (k > 80) return k < d ? 'surachat, croisement baissier' : 'surachat';
  return 'zone neutre';
}

function classifyAtr(series) {
  const valid = series.filter(v => v !== null);
  if (valid.length < 20) return { state: 'indisponible', ratio: null };
  const last = valid[valid.length - 1];
  const avg = valid.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const ratio = last / avg;
  const state = ratio > 1.15 ? 'expansion' : ratio < 0.85 ? 'compression' : 'stable';
  return { state, ratio };
}

async function main() {
  const state = await getState();
  const { bars } = await getOhlcv({ count: barCount });
  if (!bars || bars.length < 30) throw new Error(`Pas assez de bougies (${bars?.length ?? 0}).`);

  const price = bars[bars.length - 1].close;
  const stoch = stochastic(bars, { periodK: 14, smoothK: 1, periodD: 3 });
  const atrOut = atr(bars, { period: 14 });
  const vol = classifyAtr(atrOut.atr);
  const gaps = fairValueGaps(bars);
  const vp = volumeProfile(bars, { bins: 24 });

  const nearest = gaps
    .map(g => ({ ...g, distance: Math.min(Math.abs(price - g.top), Math.abs(price - g.bottom)) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 5);

  const report = {
    symbol: state.symbol,
    resolution: state.resolution,
    bars: bars.length,
    price,
    on_chart: (state.studies || []).map(s => s.name),
    stochastic: {
      k: round(stoch.lastK), d: round(stoch.lastD), state: classifyStoch(stoch.lastK, stoch.lastD),
    },
    atr: {
      value: round(atrOut.last, 3),
      pct_of_price: round((atrOut.last / price) * 100, 3),
      state: vol.state,
      vs_20_period_avg: round(vol.ratio, 2),
    },
    fair_value_gaps: { unfilled: gaps.length, nearest: nearest.map(g => ({
      type: g.type, bottom: round(g.bottom), top: round(g.top), size: round(g.size), distance: round(g.distance),
    })) },
    volume_profile: vp && {
      poc: round(vp.poc), value_area_high: round(vp.valueAreaHigh), value_area_low: round(vp.valueAreaLow),
      approximate: true,
    },
  };

  if (asJson) { console.log(JSON.stringify(report, null, 2)); return; }

  const r = report;
  console.log(`\n  ${r.symbol}  ${r.resolution}min  —  ${r.price}   (${r.bars} bougies)`);
  console.log(`  Sur le chart : ${r.on_chart.join(' | ') || 'aucun'}`);
  console.log(`  ${'─'.repeat(64)}`);
  console.log(`  Stochastique   %K ${r.stochastic.k}  %D ${r.stochastic.d}   ${r.stochastic.state}`);
  console.log(`  ATR(14)        ${r.atr.value}  (${r.atr.pct_of_price}% du prix)   ${r.atr.state} [x${r.atr.vs_20_period_avg} vs moy. 20]`);
  console.log(`  FVG non comblés ${r.fair_value_gaps.unfilled}`);
  for (const g of r.fair_value_gaps.nearest) {
    console.log(`     ${g.type === 'bullish' ? 'haussier' : 'baissier'}  ${g.bottom} → ${g.top}   (taille ${g.size}, à ${g.distance})`);
  }
  if (r.volume_profile) {
    console.log(`  Volume profile POC ${r.volume_profile.poc}   VA ${r.volume_profile.value_area_low} → ${r.volume_profile.value_area_high}   (approximé)`);
  }
  console.log('');
}

main()
  .then(() => disconnect())
  .catch(async (err) => {
    console.error(`Erreur : ${err.message}`);
    try { await disconnect(); } catch { /* ignore */ }
    process.exit(1);
  });
