#!/usr/bin/env node
/**
 * Verify the Telegram setup end to end.
 *
 *   node scripts/test-notify.js
 *
 * Reads .env, sends one test message, reports whether it arrived. Neither the
 * token nor the chat id is printed: the point is to confirm they work, not to
 * display them.
 */

import dotenv from 'dotenv';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { telegramConfigured, sendTelegram, formatSignal } from '../src/core/notify.js';

// By path, not by cwd: dotenv defaults to the working directory, so running
// this from anywhere but the project root would report the config as missing.
dotenv.config({ path: join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), '.env') });

const mask = v => (v ? `${String(v).length} caracteres` : 'absent');

async function main() {
  console.log('\n  Configuration lue depuis .env');
  console.log(`    TELEGRAM_BOT_TOKEN : ${mask(process.env.TELEGRAM_BOT_TOKEN)}`);
  console.log(`    TELEGRAM_CHAT_ID   : ${mask(process.env.TELEGRAM_CHAT_ID)}`);

  if (!telegramConfigured()) {
    console.log('\n  Incomplet. Copiez .env.example vers .env et renseignez les deux valeurs.\n');
    process.exit(1);
  }

  const sample = formatSignal({
    symbol: 'GBPUSD', direction: 'bearish', price: 1.35009,
    stochastic: { k: 77.19, d: 79.92 },
    atr: { state: 'expanding', vs_20_period_avg: 1.3 },
    volume: { ratio: 1.59, state: 'high' },
    htf: { direction: 'bearish' },
    stop: 1.35185, target: 1.34657,
  });

  console.log('\n  Envoi du message de test...');
  const r = await sendTelegram(`<b>[TEST]</b> Canal d'alerte KasperTrading\n\n${sample}`);

  if (r.ok) {
    console.log('  Envoye. Verifiez votre Telegram — le message doit y etre.\n');
  } else {
    const aide = {
      http_401: 'jeton refuse — verifiez TELEGRAM_BOT_TOKEN',
      http_400: 'requete rejetee — chat_id probablement faux, ou vous n\'avez jamais ecrit au bot',
      http_404: 'bot introuvable — jeton mal copie',
      timeout: 'pas de reponse dans les temps — reseau ou pare-feu',
      network: 'echec reseau — pas d\'acces a api.telegram.org',
      api_rejected: 'Telegram a refuse l\'envoi — verifiez le chat_id',
    }[r.reason] || r.reason;
    console.log(`  ECHEC : ${r.reason}\n  ${aide}\n`);
    process.exit(1);
  }
}

main().catch(e => { console.error(`Erreur : ${e.message}`); process.exit(1); });
