/**
 * Unit tests for Pine colour decoding — no TradingView connection needed.
 *
 * The two reference integers are real values read off LuxAlgo's Smart Money
 * Concepts on a live chart, so these tests pin the ABGR byte order against
 * actual data rather than against an assumption.
 *
 * Run: node --test tests/pine_color.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decodeColor, directionFromColor, colorFields } from '../src/core/pine-color.js';

const SMC_BEARISH = 4282726130; // 0xFF4536F2 -> ABGR gives RGB(242, 54, 69)
const SMC_BULLISH = 4286683400; // 0xFF819908 -> ABGR gives RGB(8, 153, 129)

describe('decodeColor', () => {
  it('reads Pine ints as ABGR, not ARGB', () => {
    assert.deepEqual(decodeColor(SMC_BEARISH), { r: 242, g: 54, b: 69, a: 255, hex: '#f23645' });
    assert.deepEqual(decodeColor(SMC_BULLISH), { r: 8, g: 153, b: 129, a: 255, hex: '#089981' });
  });

  it('would produce a blue for the bearish colour if read as ARGB', () => {
    // Guards the byte order: under ARGB the red channel would be 69, not 242.
    const c = decodeColor(SMC_BEARISH);
    assert.notEqual(c.r, 69, 'red channel must come from the low byte');
    assert.equal(c.b, 69);
  });

  it('handles missing input', () => {
    assert.equal(decodeColor(null), null);
    assert.equal(decodeColor(undefined), null);
    assert.equal(decodeColor(NaN), null);
  });
});

describe('directionFromColor', () => {
  it('maps the real SMC colours to a direction', () => {
    assert.equal(directionFromColor(SMC_BEARISH), 'bearish');
    assert.equal(directionFromColor(SMC_BULLISH), 'bullish');
  });

  it('treats plain green as bullish', () => {
    assert.equal(directionFromColor(0xff00ff00), 'bullish'); // ABGR: r=0 g=255 b=0
  });

  it('returns null rather than guessing on an ambiguous hue', () => {
    assert.equal(directionFromColor(0xff808080), null, 'grey');
    assert.equal(directionFromColor(0xffff8000), null, 'blue-dominant');
  });

  it('returns null for transparent or near-black', () => {
    assert.equal(directionFromColor(0x00f23645), null, 'alpha 0');
    assert.equal(directionFromColor(0xff000000), null, 'black');
    assert.equal(directionFromColor(0), null);
  });
});

describe('colorFields', () => {
  it('prefers the first candidate that carries a direction', () => {
    assert.deepEqual(colorFields(0, SMC_BULLISH), { direction: 'bullish', color_hex: '#089981' });
  });

  it('still reports the colour when the hue is ambiguous', () => {
    const out = colorFields(0xff808080);
    assert.equal(out.direction, null);
    assert.equal(out.color_hex, '#808080');
  });

  it('omits both fields when nothing is decodable', () => {
    // A drawing with no usable colour must not gain a misleading direction key.
    assert.deepEqual(colorFields(0, null, undefined), {});
    assert.equal('direction' in colorFields(0), false);
  });
});
