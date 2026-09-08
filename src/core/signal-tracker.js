/**
 * Follows a signal after it fires, so an alert read late still says something.
 *
 * The alert is a snapshot of one instant. On 2026-09-07 two buy signals fired
 * at 12:06 and 12:16 and were read six hours later, by which time the only
 * useful question -- what did it do since? -- had no answer anywhere: the stop
 * and target lived in a Telegram message and nothing compared them to the
 * price that followed. Reconstructing it meant pulling bars by hand.
 *
 * So each signal is kept until it resolves, its excursions updated from every
 * bar that arrives, and its outcome announced once. Pure functions here; the
 * monitor owns the file and the notifications.
 */

/** A signal, the moment it fires. Entry, stop and target are prices. */
export function openPosition({ symbol, direction, entry, stop, target, at, atr = null, barTime = null }) {
  if (!symbol || !direction) throw new Error('symbol et direction requis');
  for (const [name, v] of [['entry', entry], ['stop', stop], ['target', target]]) {
    if (!Number.isFinite(v)) throw new Error(`${name} doit etre un nombre`);
  }
  return {
    symbol, direction, entry, stop, target, atr,
    at: at ?? new Date().toISOString(),
    high: entry, low: entry,      // running extremes since entry
    outcome: null,                // 'target' | 'stop' | 'expired' | 'both'
    resolved_at: null,
    bars_seen: 0,
    // Newest bar already accounted for. The entry bar itself is excluded: its
    // high and low include prices from before the signal fired, and resolving a
    // position on them would credit or blame it for a move it never saw.
    last_bar_time: barTime,
  };
}

/**
 * Fold every bar that arrived since the last one seen.
 *
 * The per-tick version only ever looked at the newest bar, which is correct
 * exactly as long as the monitor never misses one. It missed 634 minutes on
 * the night of 2026-09-07: the price reached 1.35529 overnight and cleared a
 * tracked target at 1.35485, and on waking the tracker resumed from the current
 * bar, never saw it, and would have reported the signal unresolved.
 *
 * Bars are fetched 300 at a time anyway, so replaying the gap costs nothing.
 */
export function catchUpPosition(pos, bars) {
  if (pos.outcome || !Array.isArray(bars)) return pos;
  let next = pos;
  for (const bar of bars) {
    if (!bar || !Number.isFinite(bar.time)) continue;
    if (next.last_bar_time !== null && bar.time <= next.last_bar_time) continue;
    next = updatePosition(next, bar);
    if (next.outcome) break;   // stop at the bar that resolved it, not the newest
  }
  return next;
}

/**
 * Fold one bar into a position.
 *
 * Returns a new position; the input is not mutated. A bar that touches both
 * levels is reported as 'both' rather than guessed at: 15-minute bars have no
 * intrabar order, so claiming the target came first would be inventing the
 * favourable half of an ambiguity.
 */
export function updatePosition(pos, { high, low, time = null }) {
  if (pos.outcome) return pos;
  const h = Number.isFinite(high) ? high : pos.high;
  const l = Number.isFinite(low) ? low : pos.low;

  const next = {
    ...pos,
    high: Math.max(pos.high, h),
    low: Math.min(pos.low, l),
    bars_seen: pos.bars_seen + 1,
    last_bar_time: Number.isFinite(time) ? time : (pos.last_bar_time ?? null),
  };

  const long = pos.direction !== 'bearish';
  const hitStop = long ? l <= pos.stop : h >= pos.stop;
  const hitTarget = long ? h >= pos.target : l <= pos.target;

  if (hitStop && hitTarget) next.outcome = 'both';
  else if (hitStop) next.outcome = 'stop';
  else if (hitTarget) next.outcome = 'target';

  if (next.outcome) next.resolved_at = new Date().toISOString();
  return next;
}

/** Close an unresolved position -- the market shut, or it simply ran out of time. */
export function expirePosition(pos, reason = 'expired') {
  if (pos.outcome) return pos;
  return { ...pos, outcome: reason, resolved_at: new Date().toISOString() };
}

/**
 * Best and worst excursion since entry, in the instrument's own unit.
 * Signed from the trade's point of view: favourable is positive either way.
 */
export function excursions(pos, pip = 0.0001) {
  const long = pos.direction !== 'bearish';
  const favourable = long ? pos.high - pos.entry : pos.entry - pos.low;
  const adverse = long ? pos.entry - pos.low : pos.high - pos.entry;
  return {
    mfe: favourable / pip,
    mae: adverse / pip,
  };
}

/** Where the position stands right now, in the same unit. */
export function unrealised(pos, price, pip = 0.0001) {
  const long = pos.direction !== 'bearish';
  return ((long ? price - pos.entry : pos.entry - price)) / pip;
}

const OUTCOME_TEXT = {
  target: 'OBJECTIF ATTEINT',
  stop: 'STOP TOUCHE',
  both: 'STOP ET OBJECTIF touches dans la meme bougie',
  expired: 'NON RESOLU',
  market_closed: 'NON RESOLU — marche ferme',
};

/**
 * The follow-up message. Written to be read cold, hours after the alert, by
 * someone who no longer remembers the numbers: it restates the entry and the
 * levels rather than assuming the original message is still on screen.
 */
export function formatOutcome(pos, { price = null, pip = 0.0001, label = 'pips', decimals = 5 } = {}) {
  const { mfe, mae } = excursions(pos, pip);
  const dir = pos.direction === 'bearish' ? 'VENTE' : 'ACHAT';
  const opened = new Date(pos.at);
  const closed = pos.resolved_at ? new Date(pos.resolved_at) : new Date();
  const hours = (closed - opened) / 3_600_000;
  const n = v => Number(v).toFixed(decimals);
  const p = v => `${v >= 0 ? '+' : ''}${v.toFixed(1)} ${label}`;

  const lines = [
    `${OUTCOME_TEXT[pos.outcome] ?? pos.outcome} — ${dir} ${pos.symbol}`,
    '',
    `Signal du ${opened.toISOString().slice(0, 16).replace('T', ' ')} UTC, il y a ${hours.toFixed(1)} h`,
    `Entree ${n(pos.entry)}   stop ${n(pos.stop)}   objectif ${n(pos.target)}`,
    '',
    `Meilleure excursion : ${p(mfe)}`,
    `Pire excursion      : ${p(-mae)}`,
  ];
  if (price !== null) lines.push(`Prix actuel ${n(price)} (${p(unrealised(pos, price, pip))})`);
  if (pos.outcome === 'both') {
    lines.push('', 'Les deux niveaux ont ete touches dans la meme bougie de 15 min :');
    lines.push("l'ordre intrabougie est inconnu, le resultat reel est indetermine.");
  }
  lines.push('', 'Suivi d\'observation — aucune position n\'a ete prise.');
  return lines.join('\n');
}
