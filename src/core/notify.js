/**
 * Alert delivery.
 *
 * The monitor previously "alerted" by appending to a file and printing into a
 * console nobody watches. Three signals fired on 2026-09-02 and were only
 * discovered hours later. Desktop notifications turned out to be unreliable
 * here — they depend on volume, focus assist, and being at the machine — so
 * alerts go to Telegram, which reaches a phone.
 *
 * Credentials come from the environment and are never logged, echoed, or
 * included in an error message: a failure reports the HTTP status, not the URL
 * it was sent to, since the token is part of that URL.
 */

const API = 'https://api.telegram.org';

/** Configured only when both values are present; absence is not an error. */
export function telegramConfigured(env = process.env) {
  return Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID);
}

/**
 * Send a message. Resolves to { ok, reason } rather than throwing: a delivery
 * failure must never take down the polling loop or lose the alert, which is
 * written to the log regardless.
 */
export async function sendTelegram(text, { env = process.env, timeoutMs = 10000 } = {}) {
  if (!telegramConfigured(env)) return { ok: false, reason: 'not_configured' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${API}/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      // Deliberately not including the response body: Telegram echoes the
      // request, token included, in some error payloads.
      return { ok: false, reason: `http_${res.status}` };
    }
    const body = await res.json().catch(() => null);
    return body?.ok ? { ok: true } : { ok: false, reason: 'api_rejected' };
  } catch (err) {
    return { ok: false, reason: err.name === 'AbortError' ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Format a signal for Telegram. Kept here so the wording is testable. */
export function formatSignal({ symbol, direction, price, stochastic, atr, volume, htf, stop, target }) {
  const side = direction === 'bearish' ? 'VENTE' : 'ACHAT';
  const lines = [
    `<b>SIGNAL ${esc(side)} — ${esc(symbol)}</b>`,
    `prix <b>${esc(price)}</b>`,
    '',
    `stochastique K ${esc(stochastic?.k)} / D ${esc(stochastic?.d)}`,
    `ATR ${esc(atr?.state)} x${esc(atr?.vs_20_period_avg)}`,
    `volume x${esc(volume?.ratio)} ${esc(volume?.state)}`,
    `contexte 1h ${esc(htf?.direction)}`,
  ];
  if (stop != null && target != null) {
    lines.push('', `stop ${esc(stop)} · objectif ${esc(target)}`);
  }
  lines.push('', '<i>Signale vos regles. Verifiez le chart — ce n\'est pas une recommandation.</i>');
  return lines.join('\n');
}
