#!/usr/bin/env node
/**
 * Redraws docs/logo.png and docs/logo.svg from the ASCII bell below.
 *
 * The mark is the bell on the Jira Alerts MCP card at https://rrvrs.github.io,
 * where it is a monospace `<pre>` block clipped by a gradient. That cannot ship
 * as a logo — it depends on a web font and on CSS `background-clip: text`, and
 * neither survives a registry icon or a README `<img>`. So it is rebuilt here
 * as geometry: one square cell per character, under the same gradient.
 *
 * The art is the asset. Everything below is derived from it, which is why this
 * is a script and not two files someone edits by hand — the SVG is 706 path
 * segments and the PNG is a quarter of a million pixels, and the two have to
 * agree. Change ART, run `npm run build:logo`, and they still do.
 *
 * Both files are written from one geometry pass, so the PNG is not a render of
 * the SVG and does not need a rasteriser installed. 512x512 is what server.json
 * advertises to the MCP Registry; check-manifests.mjs asserts the PNG says so
 * too.
 *
 * The PNG is assembled here rather than through a dependency because the whole
 * job is axis-aligned rectangles on a rounded tile: spans of constant colour,
 * which is the one case where writing the scanlines directly is shorter than
 * configuring something to do it.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";

/**
 * The bell, exactly as the portfolio card draws it.
 *
 * Each glyph is one cell. The letters are not decoration: `8` is body, `b d p
 * q` are the corners the original art rounds, `P Y` are the half-height flare
 * of the rim, `|` the straight sides, and `. '` the single-pixel tips.
 */
const ART = `
                           p88888q
                          b8888888d
                          888888888
                          b8888888d
                        pppb88888dqqq
                    .p88888888888888888q.
                  .p888888888888888888888q.
                 p8888888888888888888888888q
                p888888888888888888888888888q
               b88888888888888888888888888888d
              b8888888888888888888888888888888d
              888888888888888888888888888888888
             |888888888888888888888888888888888|
             |888888888888888888888888888888888|
             |888888888888888888888888888888888|
             |888888888888888888888888888888888|
             |888888888888888888888888888888888|
             |888888888888888888888888888888888|
             b888888888888888888888888888888888d
            p88888888888888888888888888888888888q
           p8888888888888888888888888888888888888q
         |88888888888888888888888888888888888888888|
         bPPPPPPPPPPPPPPPPbb88888ddYYYYYYYYYYYYYYYYd
                         b888888888d
                         88888888888
                         88888888888
                         b888888888d
                          'P88888Y'
`;

const SIZE = 512;

// Cell pitch. A monospace advance is 0.6em against a 1.15 line-height, so the
// grid is roughly 1 : 1.7 — the proportion that makes the bell read as a bell
// rather than a squashed one. 7 x 12 is that ratio in whole pixels at 512.
const CELL_W = 7;
const CELL_H = 12;

// Each cell is drawn 1px inside its box and stroked back out with a round join,
// which is how a 6x9 block gets a 1px corner radius without a path per corner.
const STROKE = 2;

/** Where each glyph sits in its cell: [x, y, width, height]. */
const BLOCK = [0.5, 1.5, 6, 9];
const GLYPHS = {
  8: BLOCK,
  b: BLOCK,
  d: BLOCK,
  p: BLOCK,
  q: BLOCK,
  P: [0.5, 1.5, 6, 5.5],
  Y: [0.5, 1.5, 6, 5.5],
  "|": [2, 1.5, 3, 9],
  ".": [1.75, 7, 3.5, 3.5],
  "'": [1.75, 1.5, 3.5, 3.5],
};

// The card's own gradient, `.asterisk__art` on the portfolio, converted out of
// oklch into sRGB: oklch(60% .18 272) -> oklch(60% .17 275) 45% ->
// oklch(64% .13 330) 75% -> oklch(72% .12 10). Hex rather than oklch because an
// SVG icon is rendered by whatever the registry or a README viewer happens to
// use, and oklch() in a `stop-color` is not something to bet the mark on.
const BELL_STOPS = [
  [0, [0x5d, 0x73, 0xea]],
  [0.45, [0x65, 0x72, 0xe4]],
  [0.75, [0xb8, 0x6d, 0xb1]],
  [1, [0xe4, 0x83, 0x93]],
];

// The tile is part of the asset, not a backdrop for it: GitHub serves the
// README on white and the registry on near-black, and a bell with a transparent
// background would have to work on both. This one carries its own.
const TILE_TOP = [0x0c, 0x0c, 0x11];
const TILE_BOTTOM = [0x07, 0x07, 0x09];
const GLOW = [0x5d, 0x73, 0xea];
const RADIUS = 118;

const url = (path) => new URL(`../${path}`, import.meta.url);

// --- Geometry ---------------------------------------------------------------

const lines = ART.split("\n").filter((line) => line.trim().length > 0);
const left = Math.min(...lines.map((line) => line.length - line.trimStart().length));
const right = Math.max(...lines.map((line) => line.trimEnd().length));
const columns = right - left;
const originX = (SIZE - columns * CELL_W) / 2;
const originY = (SIZE - lines.length * CELL_H) / 2;
const bellHeight = lines.length * CELL_H;

/** Every drawn cell, as [x, y, width, height] in the 512x512 frame. */
const cells = lines.flatMap((line, row) =>
  [...line.slice(left, right)].flatMap((glyph, column) => {
    if (glyph === " ") return [];
    const box = GLYPHS[glyph];
    if (!box) throw new Error(`ART uses ${JSON.stringify(glyph)}, which has no cell shape`);
    const [dx, dy, width, height] = box;
    return [[originX + column * CELL_W + dx, originY + row * CELL_H + dy, width, height]];
  }),
);

/** The gradient colour at a point down the bell, 0 at its top and 1 at its foot. */
function bellColor(t) {
  const clamped = Math.min(1, Math.max(0, t));
  for (let i = 1; i < BELL_STOPS.length; i += 1) {
    const [from, a] = BELL_STOPS[i - 1];
    const [to, b] = BELL_STOPS[i];
    if (clamped > to) continue;
    const f = to === from ? 0 : (clamped - from) / (to - from);
    return a.map((channel, c) => channel + (b[c] - channel) * f);
  }
  return BELL_STOPS.at(-1)[1];
}

const hex = (rgb) => `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`;

// --- SVG --------------------------------------------------------------------

function renderSvg() {
  const n = (value) => String(Number(value.toFixed(2)));
  const path = cells
    .map(([x, y, width, height]) => {
      const [px, py] = [x + STROKE / 2, y + STROKE / 2];
      const [pw, ph] = [width - STROKE, height - STROKE];
      return `M${n(px)} ${n(py)}h${n(pw)}v${n(ph)}h-${n(pw)}z`;
    })
    .join("");

  const stops = BELL_STOPS.map(
    ([offset, rgb]) => `<stop offset="${offset * 100}%" stop-color="${hex(rgb)}"/>`,
  ).join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}" width="${SIZE}" height="${SIZE}" role="img" aria-labelledby="t d">
  <title id="t">Jira Alerts MCP</title>
  <desc id="d">An alert bell drawn in monospace character cells, lit by an indigo-to-coral gradient on a near-black tile.</desc>
  <!-- Generated by scripts/make-logo.mjs from the ASCII bell it carries. Edit
       that, not this: the path below is one segment per character. -->
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${hex(TILE_TOP)}"/>
      <stop offset="100%" stop-color="${hex(TILE_BOTTOM)}"/>
    </linearGradient>
    <radialGradient id="glow" cx="50%" cy="16%" r="76%">
      <stop offset="0%" stop-color="${hex(GLOW)}" stop-opacity="0.22"/>
      <stop offset="100%" stop-color="${hex(GLOW)}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="rim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.16"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0.04"/>
    </linearGradient>
    <linearGradient id="bell" gradientUnits="userSpaceOnUse" x1="0" y1="${originY}" x2="0" y2="${originY + bellHeight}">${stops}</linearGradient>
  </defs>
  <rect width="${SIZE}" height="${SIZE}" rx="${RADIUS}" fill="url(#tile)"/>
  <rect width="${SIZE}" height="${SIZE}" rx="${RADIUS}" fill="url(#glow)"/>
  <rect x="1" y="1" width="${SIZE - 2}" height="${SIZE - 2}" rx="${RADIUS - 1}" fill="none" stroke="url(#rim)" stroke-width="2"/>
  <path fill="url(#bell)" stroke="url(#bell)" stroke-width="${STROKE}" stroke-linejoin="round" d="${path}"/>
</svg>
`;
}

// --- PNG --------------------------------------------------------------------

const SAMPLES = 4;

/**
 * Coverage in [0, 1] for every pixel, from rectangles with rounded corners.
 *
 * Sampled SAMPLES x SAMPLES, but by span rather than by sample: a scanline
 * through an axis-aligned rectangle is one interval, so each row costs two
 * partial pixels and a fill. The corner radius only moves where that interval
 * starts and ends.
 */
function coverage(rects, radius = 0) {
  const acc = new Float64Array(SIZE * SIZE);

  for (const [x, y, width, height] of rects) {
    const r = Math.min(radius, width / 2, height / 2);
    const first = Math.max(0, Math.floor(y * SAMPLES));
    const last = Math.min(SIZE * SAMPLES, Math.ceil((y + height) * SAMPLES));

    for (let sy = first; sy < last; sy += 1) {
      const cy = (sy + 0.5) / SAMPLES;
      if (cy < y || cy > y + height) continue;

      let inset = 0;
      if (r > 0) {
        const dy = Math.max(0, y + r - cy, cy - (y + height - r));
        if (dy > 0) inset = r - Math.sqrt(Math.max(0, r * r - dy * dy));
      }

      const from = (x + inset) * SAMPLES;
      const to = (x + width - inset) * SAMPLES;
      if (to <= from) continue;

      const row = Math.floor(sy / SAMPLES) * SIZE;
      const firstPixel = Math.floor(from / SAMPLES);
      const lastPixel = Math.floor((to - 1e-9) / SAMPLES);

      if (firstPixel === lastPixel) {
        acc[row + firstPixel] += to - from;
        continue;
      }
      acc[row + firstPixel] += (firstPixel + 1) * SAMPLES - from;
      for (let p = firstPixel + 1; p < lastPixel; p += 1) acc[row + p] += SAMPLES;
      acc[row + lastPixel] += to - lastPixel * SAMPLES;
    }
  }

  const total = SAMPLES * SAMPLES;
  return acc.map((value) => Math.min(1, value / total));
}

function renderPng() {
  const tile = coverage([[0, 0, SIZE, SIZE]], RADIUS);
  const rimOuter = coverage([[1, 1, SIZE - 2, SIZE - 2]], RADIUS - 1);
  const rimInner = coverage([[3, 3, SIZE - 6, SIZE - 6]], RADIUS - 3);

  // Same two-pass shape as the SVG's fill-plus-round-join stroke.
  const inner = coverage(
    cells.map(([x, y, width, height]) => [x + 1, y + 1, width - 2, height - 2]),
  );
  const outer = coverage(cells, 1);
  const bell = inner.map((value, i) => Math.min(1, value + outer[i]));

  const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
  let at = 0;

  for (let py = 0; py < SIZE; py += 1) {
    raw[at] = 0; // filter: none — the image is flat colour, so filtering buys nothing
    at += 1;

    const fy = (py + 0.5) / SIZE;
    const tileRgb = TILE_TOP.map((c, i) => c + (TILE_BOTTOM[i] - c) * fy);
    const bellRgb = bellColor((py + 0.5 - originY) / bellHeight);
    const rimAlpha = 0.16 + (0.04 - 0.16) * fy;

    for (let px = 0; px < SIZE; px += 1) {
      const i = py * SIZE + px;
      const alpha = tile[i];
      if (alpha <= 0) {
        at += 4;
        continue;
      }

      const dx = (px + 0.5) / SIZE - 0.5;
      const dy = fy - 0.16;
      const glow = Math.max(0, 1 - Math.hypot(dx, dy) / 0.76) * 0.22;
      const rim = Math.max(0, rimOuter[i] - rimInner[i]) * rimAlpha;

      for (let c = 0; c < 3; c += 1) {
        let value = tileRgb[c] + (GLOW[c] - tileRgb[c]) * glow;
        value += (255 - value) * rim;
        value += (bellRgb[c] - value) * bell[i];
        raw[at + c] = Math.round(value);
      }
      raw[at + 3] = Math.round(alpha * 255);
      at += 4;
    }
  }

  const chunk = (tag, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(tag, 4, "ascii");
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, tail]);
  };

  const header = Buffer.alloc(13);
  header.writeUInt32BE(SIZE, 0);
  header.writeUInt32BE(SIZE, 4);
  header[8] = 8; // 8 bits per channel
  header[9] = 6; // truecolour with alpha

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// --- Write ------------------------------------------------------------------

const outputs = [
  ["docs/logo.svg", Buffer.from(renderSvg(), "utf8")],
  ["docs/logo.png", renderPng()],
];

const written = [];
for (const [path, next] of outputs) {
  let current;
  try {
    current = readFileSync(url(path));
  } catch {
    current = null;
  }
  if (current?.equals(next)) continue;
  writeFileSync(url(path), next);
  written.push(path);
}

console.log(`✓ ${cells.length} cells on a ${columns}x${lines.length} grid at ${SIZE}x${SIZE}`);
if (written.length === 0) {
  console.log("✓ docs/logo.svg and docs/logo.png were already up to date");
} else {
  for (const path of written) console.log(`    wrote ${path}`);
}
