#!/usr/bin/env node
/**
 * Find your Telegram chat id without handling the token by hand.
 *
 *   node scripts/find-chat-id.js
 *
 * Reads TELEGRAM_BOT_TOKEN from .env, calls getUpdates, and prints only the
 * chat ids it finds. The documented alternative — pasting the token into a
 * browser address bar — puts it in history, in the URL bar, and in anything
 * syncing that browser. This keeps it in the one file that is gitignored.
 *
 * The token is never printed, and error output carries the HTTP status only:
 * Telegram echoes the request URL, token included, in some error payloads.
 */

import dotenv from 'dotenv';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// By path, not by cwd — see test-notify.js.
dotenv.config({ path: join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), '.env') });

const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token) {
  console.log('\n  TELEGRAM_BOT_TOKEN absent de .env.');
  console.log('  Renseignez-le d\'abord, puis relancez.\n');
  process.exit(1);
}

const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`).catch(() => null);

if (!res) {
  console.log('\n  Pas de reponse d\'api.telegram.org — reseau ou pare-feu.\n');
  process.exit(1);
}
if (!res.ok) {
  const aide = { 401: 'jeton refuse — verifiez TELEGRAM_BOT_TOKEN dans .env', 404: 'bot introuvable — jeton mal copie' }[res.status];
  console.log(`\n  Telegram a repondu ${res.status}${aide ? ` — ${aide}` : ''}\n`);
  process.exit(1);
}

const body = await res.json().catch(() => null);
const updates = body?.result ?? [];

if (!updates.length) {
  console.log('\n  Aucun message recu par le bot.');
  console.log('  Ouvrez Telegram, ecrivez n\'importe quoi a votre bot, puis relancez.');
  console.log('  (getUpdates ne montre que les messages recents et non encore consommes.)\n');
  process.exit(1);
}

const chats = new Map();
for (const u of updates) {
  const c = u.message?.chat ?? u.edited_message?.chat ?? u.channel_post?.chat;
  if (c?.id != null) chats.set(c.id, c.type);
}

console.log('\n  Chat id trouve(s) :\n');
for (const [id, type] of chats) console.log(`    ${id}    (${type})`);
console.log('\n  Copiez-le dans .env :  TELEGRAM_CHAT_ID=<id>');
console.log('  Puis verifiez avec :   node scripts/test-notify.js\n');
