#!/usr/bin/env node
/**
 * Stop distance and lot size for the current market, from live ATR.
 *
 *   node scripts/size.js                       # 2% risk, 2x ATR
 *   node scripts/size.js --risk 2.5 --atr 1.5  # percent, ATR multiple
 *   node scripts/size.js --min-lot 0.001       # broker minimum
 *
 * Reports the risk it would actually take rather than assuming the position
 * fits: on a small account the broker's smallest lot can already exceed the
 * budget, and that has to be visible instead of rounded away.
 */

import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as chart from '../src/core/chart.js';
import * as data from '../src/core/data.js';
import { disconnect } from '../src/connection.js';
import { summarise } from '../src/core/derived-indicators.js';
import { sizePosition, targetDistance, CONTRACT } from '../src/core/position.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const val = (n, d) => { const i = args.indexOf(n); return i !== -1 && args[i + 1] ? Number(args[i + 1]) : d; };

const RISK_PCT = val('--risk', 2) / 100;
const ATR_MULT = val('--atr', 2);
const MIN_LOT = val('--min-lot', 0.01);
const LOT_STEP = val('--lot-step', MIN_LOT);

const money = n => n.toFixed(2);

async function main() {
  const rules = JSON.parse(readFileSync(join(ROOT, 'rules.json'), 'utf8'));
  const account = rules.account?.balance_usd ?? 100;
  const timeframe = rules.default_timeframe || '15';
  const rr = 2;

  console.log(`\n  Compte ${money(account)} USD · risque ${(RISK_PCT * 100).toFixed(1)}% · stop ${ATR_MULT}x ATR · lot min ${MIN_LOT}\n`);

  const original = await chart.getState().catch(() => null);

  for (const symbol of rules.watchlist || []) {
    const key = symbol.replace(/^[A-Z]+:/, '').toUpperCase();
    const contract = CONTRACT[key];
    if (!contract) { console.log(`  ${symbol} : contrat inconnu, ignore`); continue; }

    await chart.setSymbol({ symbol });
    await new Promise(r => setTimeout(r, 900));
    await chart.setTimeframe({ timeframe });
    await new Promise(r => setTimeout(r, 900));

    const { bars } = await data.getOhlcv({ count: 300 });
    const s = summarise(bars, { include: new Set(['atr']) });
    const atr = s.atr?.value;
    if (!atr) { console.log(`  ${symbol} : ATR indisponible`); continue; }

    const r = sizePosition({ atr, account, riskPct: RISK_PCT, atrMultiple: ATR_MULT, contract, minLot: MIN_LOT, lotStep: LOT_STEP });
    const tp = targetDistance(r.stopDistance, rr);

    console.log(`  ${key}  prix ${s.price}   ATR ${atr}`);
    console.log(`    stop      ${r.stopDistance.toFixed(contract.pip < 1 ? 5 : 2)}  (${r.stopInLabel.toFixed(1)} ${r.label})`);
    console.log(`    objectif  ${tp.toFixed(contract.pip < 1 ? 5 : 2)}  (R:R 1:${rr})`);
    if (r.tradable) {
      console.log(`    lot       ${r.lots.toFixed(3)}   risque ${money(r.riskAmount)} USD = ${(r.riskPctActual * 100).toFixed(2)}%`);
    } else {
      console.log(`    lot       AUCUN`);
      for (const w of r.warnings) console.log(`    /!\\ ${w}`);
    }
    console.log('');
  }

  if (original?.symbol) {
    await chart.setSymbol({ symbol: original.symbol }).catch(() => {});
    if (original.resolution) await chart.setTimeframe({ timeframe: original.resolution }).catch(() => {});
  }
}

main().then(() => disconnect()).catch(async (e) => {
  console.error(`Erreur : ${e.message}`);
  try { await disconnect(); } catch {}
  process.exit(1);
});
