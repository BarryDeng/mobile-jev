import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bestIconAt, findIcons, iconTemplate } from './icon-match.mjs';
import { loadLayout } from './layout.mjs';
import { decodePng } from './png.mjs';
import { markerBearing } from './routines.mjs';

const GROUND = [60, 90, 60];
// A quest-icon-like diamond: an `edge` coloured outline around a `core` coloured centre.
const KINDS = {
  gold: { edge: [230, 170, 20], core: [255, 240, 40] },
  blue: { edge: [120, 140, 230], core: [90, 200, 255] },
};
function canvas(width, height) {
  const pixels = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i++) pixels.set(GROUND, i * 3);
  return { width, height, channels: 3, pixels };
}
function drawIcon(image, x, y, { edge, core }, dim = 1) {
  for (let dy = -6; dy <= 6; dy++)
    for (let dx = -6; dx <= 6; dx++) {
      const d = Math.abs(dx) + Math.abs(dy);
      const rgb = d <= 2 ? core : d >= 5 && d <= 6 ? edge : d <= 6 ? [40, 40, 60] : null;
      if (rgb)
        image.pixels.set(
          rgb.map((v) => Math.round(v * dim)),
          ((y + dy) * image.width + x + dx) * 3,
        );
    }
  return image;
}
const template = (kind) => iconTemplate(drawIcon(canvas(15, 15), 7, 7, KINDS[kind]));

test('findIcons finds each icon of a kind by shape and colour, best first', () => {
  const image = drawIcon(
    drawIcon(drawIcon(canvas(120, 100), 30, 30, KINDS.gold), 80, 60, KINDS.gold),
    60,
    20,
    KINDS.blue,
  );
  const gold = findIcons(image, { cx: 60, cy: 50, radius: 50 }, [template('gold')]);
  assert.deepEqual(
    gold.map(({ x, y }) => [x, y]).sort((a, b) => a[0] - b[0]),
    [
      [30, 30],
      [80, 60],
    ],
  );
  assert.ok(gold.every((icon) => icon.s > 0.95));
  const blue = findIcons(image, { cx: 60, cy: 50, radius: 50 }, [template('blue')]);
  assert.deepEqual(
    blue.map(({ x, y }) => [x, y]),
    [[60, 20]],
  );
  assert.equal(
    findIcons(canvas(120, 100), { cx: 60, cy: 50, radius: 50 }, [template('gold')]).length,
    0,
  );
});

test('a dimmed icon still passes the colour gate, a differently coloured one does not', () => {
  const image = drawIcon(canvas(60, 40), 30, 20, KINDS.gold, 0.55);
  assert.ok(bestIconAt(image, 30, 20, template('gold'), { maxColor: 60 }).s > 0.9);
  const blue = drawIcon(canvas(60, 40), 30, 20, KINDS.blue);
  assert.equal(bestIconAt(blue, 30, 20, template('gold'), { maxColor: 60 }).s, 0);
});

test('a template drawn at twice the size is matched with k = 2', () => {
  const big = canvas(80, 80);
  for (let y = 0; y < 15; y++)
    for (let x = 0; x < 15; x++) {
      const rgb = rgbAt3(drawIcon(canvas(15, 15), 7, 7, KINDS.gold), x, y);
      for (const [ox, oy] of [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
      ])
        big.pixels.set(rgb, ((26 + y * 2 + oy) * 80 + 26 + x * 2 + ox) * 3);
    }
  const [icon] = findIcons(big, { cx: 40, cy: 40, radius: 30 }, [template('gold')], { k: 2 });
  assert.ok(Math.abs(icon.x - 40) <= 1 && Math.abs(icon.y - 40) <= 1, `at ${icon.x},${icon.y}`);
});
const rgbAt3 = (image, x, y) => [
  ...image.pixels.subarray((y * image.width + x) * 3, (y * image.width + x) * 3 + 3),
];

const MAP = { left: 10, top: 10, right: 90, bottom: 90 };
const SCREEN = { width: 120, height: 100 };
const at = (deg, r) => [
  Math.round(50 + r * 40 * Math.cos((deg * Math.PI) / 180)),
  Math.round(50 - r * 40 * Math.sin((deg * Math.PI) / 180)),
];
const off = (a, b) => Math.abs(((((a - b + 180) % 360) + 360) % 360) - 180);
const track = (extra = {}) => ({
  kind: 'gold',
  templates: [template('gold')],
  others: [template('blue')],
  threshold: 0.65,
  ...extra,
});

test('markerBearing with a tracked kind follows that icon by shape', () => {
  const image = drawIcon(
    drawIcon(canvas(120, 100), ...at(30, 0.6), KINDS.blue),
    ...at(200, 0.5),
    KINDS.gold,
  );
  const marker = markerBearing(
    image,
    SCREEN,
    MAP,
    { rgb: [251, 232, 2], tolerance: 30, track: track() },
    1.35,
  );
  assert.ok(off(marker.deg, 200) < 4, `gold at ${marker.deg}`);
  assert.ok(Math.abs(marker.r - 0.5) < 0.05);
  assert.equal(marker.icon.kind, 'gold');
  // The tracked kind's icon is gone: no bearing, rather than the other kind's icon.
  const blueOnly = drawIcon(canvas(120, 100), ...at(30, 0.6), KINDS.blue);
  assert.equal(markerBearing(blueOnly, SCREEN, MAP, { track: track() }, 1.35), null);
});

test('with several icons of the tracked kind, the HUD distance and the last pick decide', () => {
  const image = drawIcon(
    drawIcon(canvas(120, 100), ...at(30, 0.3), KINDS.gold),
    ...at(200, 0.9),
    KINDS.gold,
  );
  const far = track({ r: 1.0 });
  assert.ok(off(markerBearing(image, SCREEN, MAP, { track: far }, 1.35).deg, 200) < 4);
  // Next frame the HUD distance is unchanged but the pick stays with the icon it followed.
  const moved = drawIcon(
    drawIcon(canvas(120, 100), ...at(30, 0.3), KINDS.gold),
    ...at(195, 0.85),
    KINDS.gold,
  );
  const next = markerBearing(moved, SCREEN, MAP, { track: track({ r: 0.2 }) }, 1.35);
  assert.ok(off(next.deg, 30) < 4, 'without a last pick the HUD distance wins');
  const kept = markerBearing(moved, SCREEN, MAP, { track: { ...far, r: 0.2 } }, 1.35);
  assert.ok(off(kept.deg, 195) < 4, `kept the followed icon, got ${kept.deg}`);
  assert.equal(kept.icon.candidates, 2);
});

test('the Genshin layout loads its quest icon templates, which match their own crops', () => {
  const layout = loadLayout('layouts/genshin-impact.json');
  const { icons } = layout.routines.find((r) => r.marker?.icons).marker;
  for (const [kind, spec] of Object.entries(icons.kinds)) {
    assert.equal(spec.hudTemplates.length, spec.hud.length, kind);
    assert.equal(spec.minimapTemplates.length, spec.minimap.length, kind);
    assert.ok(!Object.keys(spec).includes('minimapTemplates'), 'templates stay out of JSON');
    const crop = decodePng(readFileSync(`layouts/${spec.minimap[0]}`));
    const c = Math.floor(crop.width / 2);
    assert.ok(bestIconAt(crop, c, c, spec.minimapTemplates[0], { search: 0 }).s > 0.99, kind);
  }
});
