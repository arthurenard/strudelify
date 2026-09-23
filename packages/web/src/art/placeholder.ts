/** The deterministic placeholder picture. See ../art.ts. */
import { normalize, normalizeArtist } from './match.js';
import { fnv1a } from '../tint.js';
import type { ArtInfo } from './types.js';

/** hsl (h in degrees, s and l in percent) → hex, so the value is usable in every CSS/canvas context. */
function hsl(h: number, s: number, l: number): string {
  const sl = s / 100;
  const ll = l / 100;
  const a = sl * Math.min(ll, 1 - ll);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const c = ll - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/** Deterministic gradient + initial, as an SVG data URI. Same title → same picture, on every machine. */
export function placeholderArt(title: string, artist = ''): ArtInfo {
  const h = fnv1a(`${normalize(title)}|${normalizeArtist(artist)}`);
  const hue1 = h % 360;
  const hue2 = (hue1 + 50 + ((h >>> 9) % 120)) % 360;
  const angle = (h >>> 17) % 360;
  const c1 = hsl(hue1, 55, 30);
  const c2 = hsl(hue2, 60, 18);
  const initial = (title.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 1) || '♪').toUpperCase();
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600">` +
    `<defs><linearGradient id="g" gradientTransform="rotate(${angle} 0.5 0.5)"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs>` +
    `<rect width="600" height="600" fill="url(#g)"/>` +
    `<circle cx="${150 + ((h >>> 3) % 300)}" cy="${150 + ((h >>> 11) % 300)}" r="${120 + ((h >>> 5) % 120)}" fill="#fff" fill-opacity="0.06"/>` +
    `<text x="300" y="300" text-anchor="middle" dominant-baseline="central" font-family="system-ui, -apple-system, Segoe UI, Helvetica, Arial, sans-serif" font-size="320" font-weight="800" fill="#fff" fill-opacity="0.35">${initial.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</text>` +
    `</svg>`;
  return { art: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, source: 'placeholder', kind: 'placeholder' };
}
