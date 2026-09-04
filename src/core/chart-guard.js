/**
 * Guards against reading one instrument's bars and labelling them as another's.
 *
 * Every reader in this toolchain does the same thing: ask TradingView to switch
 * symbol, wait, then read. The wait was a fixed sleep, which is a guess about
 * how long a switch takes — and when the guess was wrong the read returned the
 * *previous* symbol's bars, tagged with the name of the one we asked for.
 *
 * It happened nine times across four days of monitoring: on 2026-09-01 eight
 * ticks and on 2026-09-04 one, all immediately after a monitor restart, all
 * carrying a four-digit index price under the label GBPUSD. None reached a
 * signal, but nothing stopped them from doing so — the staleness guard rejects
 * bars that are old, not bars that belong to something else.
 *
 * So: wait until the chart *says* it is where we asked, and check again after
 * the read. Both ends have to agree before a reading is trusted.
 */

/**
 * True when the chart's symbol denotes the one requested.
 *
 * The chart reports an exchange-qualified name ("FX:GBPUSD") while callers ask
 * for a bare ticker ("GBPUSD"), so the suffix form counts as a match. The colon
 * is required: without it "XGBPUSD" would match "GBPUSD".
 */
export function symbolMatches(stateSymbol, wanted) {
  if (!stateSymbol || !wanted) return false;
  const a = String(stateSymbol);
  const b = String(wanted);
  return a === b || a.endsWith(`:${b}`) || b.endsWith(`:${a}`);
}

/** True when the chart's resolution is the one requested. Compared as strings: the API returns "15", callers may pass 15. */
export function resolutionMatches(stateResolution, wanted) {
  if (stateResolution === null || stateResolution === undefined) return false;
  if (wanted === null || wanted === undefined) return true;  // caller does not care
  return String(stateResolution) === String(wanted);
}

/**
 * Poll the chart until it reports the requested symbol and timeframe.
 *
 * Returns the matching state, or null if the deadline passes without one — a
 * caller that gets null must discard the tick rather than read anyway, which is
 * the whole point of the exercise.
 *
 * getState and sleep are injected so this is testable without a live chart.
 */
export async function awaitChart({ symbol, timeframe = null, getState, sleep, deadlineMs = 8000, pollMs = 300 }) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const st = await getState().catch(() => null);
    if (symbolMatches(st?.symbol, symbol) && resolutionMatches(st?.resolution, timeframe)) return st;
    if (Date.now() >= deadline) return null;
    await sleep(pollMs);
  }
}

/**
 * Describe a chart that is not where it should be, for an error message.
 * Kept here so the monitor and the snapshot script word it identically.
 */
export function describeMismatch(state, symbol, timeframe) {
  const got = state ? `${state.symbol ?? '?'} en ${state.resolution ?? '?'} min` : 'etat du graphique illisible';
  const want = timeframe === null || timeframe === undefined ? symbol : `${symbol} en ${timeframe} min`;
  return `graphique sur ${got}, attendu ${want}`;
}
