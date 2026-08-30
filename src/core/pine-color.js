/**
 * Decoding Pine drawing colours.
 *
 * Pine stores a colour as a 32-bit integer in **ABGR** order, not ARGB: the
 * low byte is red. Verified against LuxAlgo's Smart Money Concepts, whose
 * bearish labels carry 4282726130 -> RGB(242, 54, 69) and bullish ones
 * 4286683400 -> RGB(8, 153, 129). Read as ARGB those same values decode to an
 * implausible blue and olive.
 */

/** Split a Pine colour int into channels plus a hex string. */
export function decodeColor(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return null;
  const a = (n >>> 24) & 0xff;
  const b = (n >>> 16) & 0xff;
  const g = (n >>> 8) & 0xff;
  const r = n & 0xff;
  const hex = '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
  return { r, g, b, a, hex };
}

/**
 * Infer bullish/bearish from a drawing's colour.
 *
 * This is a CONVENTION, not data: Pine exposes no direction field, and almost
 * every indicator paints bearish red and bullish green or teal. It holds for
 * the common palettes but an indicator using its own scheme will read wrong,
 * so callers get the decoded colour alongside and null whenever the hue is not
 * decisively one or the other — never a coin-flip guess.
 */
export function directionFromColor(n) {
  const c = decodeColor(n);
  if (!c || c.a === 0) return null;          // fully transparent carries no signal
  const { r, g, b } = c;
  if (Math.max(r, g, b) < 40) return null;   // near-black: default styling, not a signal
  if (r > g + 40 && r > b + 40) return 'bearish';
  // Green must beat red clearly AND not be swamped by blue, or a blue such as
  // RGB(0,128,255) would pass on its green channel alone. The slack keeps teal
  // like RGB(8,153,129), where blue is high but still below green.
  if (g > r + 40 && g + 40 > b) return 'bullish';
  return null;
}

/**
 * Attach direction + colour to a drawing, picking the first colour that
 * actually carries a hue. Returns the fields to spread onto the result;
 * omits them entirely when nothing decodable is present, so a caller never
 * sees a misleading `direction: null` on a drawing that has no colour at all.
 */
export function colorFields(...candidates) {
  for (const n of candidates) {
    const dir = directionFromColor(n);
    if (dir) return { direction: dir, color_hex: decodeColor(n).hex };
  }
  for (const n of candidates) {
    const c = decodeColor(n);
    if (c && c.a !== 0 && Math.max(c.r, c.g, c.b) >= 40) {
      return { direction: null, color_hex: c.hex };
    }
  }
  return {};
}
