import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BLOCK,
  OUTSIDE,
  UNKNOWN,
  WALK,
  minimapGrid,
  planRoute,
  rayClear,
  terrainOf,
} from './minimap-path.mjs';

const PALETTE = {
  walk: [[190, 180, 140]],
  block: [[140, 100, 70]],
  icons: [{ min: [226, 226, 226] }, { max: [95, 95, 95], maxChroma: 12 }],
};

const open = (cells) => ({ cells, grid: new Uint8Array(cells * cells).fill(WALK) });

test('terrainOf maps palette colours and icons', () => {
  assert.equal(terrainOf([192, 178, 142], PALETTE), WALK);
  assert.equal(terrainOf([138, 102, 72], PALETTE), BLOCK);
  assert.equal(terrainOf([250, 250, 250], PALETTE), UNKNOWN);
  assert.equal(terrainOf([60, 62, 58], PALETTE), UNKNOWN);
  assert.equal(terrainOf([0, 0, 255], PALETTE), UNKNOWN);
});

test('minimapGrid votes cells inside the circle', () => {
  const width = 100,
    height = 100;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const [r, g, b] = x < 50 ? [190, 180, 140] : [140, 100, 70];
      data.set([r, g, b, 255], (y * width + x) * 4);
    }
  const image = { width, height, channels: 4, pixels: data };
  const { cells, grid } = minimapGrid(
    image,
    { width, height },
    { left: 0, top: 0, right: 100, bottom: 100 },
    PALETTE,
    10,
  );
  assert.equal(grid[0], OUTSIDE);
  assert.equal(grid[5 * cells + 2], WALK);
  assert.equal(grid[5 * cells + 7], BLOCK);
});

test('planRoute heads straight on open ground', () => {
  const plan = planRoute(open(31), { deg: 90, r: 3 });
  assert.equal(plan.direct, true);
  assert.ok(Math.abs(plan.bearing - 90) < 5, `bearing ${plan.bearing}`);
});

test('planRoute goes around a wall between the player and the goal', () => {
  const g = open(31);
  // A wall north of the player, open only at its east end.
  for (let x = 2; x < 26; x++) g.grid[10 * 31 + x] = BLOCK;
  const plan = planRoute(g, { deg: 90, r: 3 }, { inflate: 1 });
  assert.equal(plan.direct, false);
  assert.ok(plan.bearing > 0 && plan.bearing < 80, `bearing ${plan.bearing}`);
  assert.ok(plan.end.y < 10, 'route passes the wall');
});

test('rayClear sees a wall across the way, but not one to the side', () => {
  const g = open(31);
  for (let x = 12; x < 19; x++) g.grid[10 * 31 + x] = BLOCK;
  assert.equal(rayClear(g, 90, 8), false);
  assert.equal(rayClear(g, 0, 8), true);
  assert.equal(rayClear(g, 180, 8), true);
});

test('planRoute finds no way out of an enclosure', () => {
  const g = open(31);
  for (let i = 10; i <= 20; i++) {
    g.grid[10 * 31 + i] = BLOCK;
    g.grid[20 * 31 + i] = BLOCK;
    g.grid[i * 31 + 10] = BLOCK;
    g.grid[i * 31 + 20] = BLOCK;
  }
  const plan = planRoute(g, { deg: 0, r: 3 }, { inflate: 0 });
  // Inside the box the best cell is its east edge, short of the goal; never past the wall.
  assert.ok(plan.end.x < 20);
  const boxed = open(31);
  boxed.grid.fill(BLOCK);
  assert.equal(planRoute(boxed, { deg: 0, r: 3 }, { clearStart: 0 }).bearing, null);
});

test('minimapGrid flags water cells, and planRoute keeps off the shore when asked', () => {
  const palette = { ...PALETTE, water: [[40, 110, 130]] };
  assert.equal(terrainOf([42, 108, 128], palette), BLOCK);
  const width = 100,
    height = 100;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      data.set([...(y > 60 ? [40, 110, 130] : [190, 180, 140]), 255], (y * width + x) * 4);
  const image = { width, height, channels: 4, pixels: data };
  const box = { left: 0, top: 0, right: 100, bottom: 100 };
  const { water } = minimapGrid(image, { width, height }, box, palette, 10);
  assert.equal(water[8 * 10 + 5], 1);
  assert.equal(water[3 * 10 + 5], 0);

  // Sea along the south; the goal is due east. A shore cost lifts the route off the coast.
  const g = open(31);
  g.water = new Uint8Array(31 * 31);
  for (let y = 17; y < 31; y++)
    for (let x = 0; x < 31; x++) {
      g.grid[y * 31 + x] = BLOCK;
      g.water[y * 31 + x] = 1;
    }
  const coast = planRoute(g, { deg: 0, r: 3 }, { inflate: 0 });
  const inland = planRoute(g, { deg: 0, r: 3 }, { inflate: 0, shore: { margin: 3, cost: 3 } });
  const maxY = (plan) => Math.max(...plan.path.slice(6).map((p) => p.y));
  assert.ok(maxY(coast) >= 14, `coast ${maxY(coast)}`);
  assert.ok(maxY(inland) < 14, `inland ${maxY(inland)}`);
});
