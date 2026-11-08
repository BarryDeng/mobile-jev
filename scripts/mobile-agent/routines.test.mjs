import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  approach,
  coneHeading,
  combat,
  enemyBars,
  findEnemies,
  dialogue,
  explore,
  markerBearing,
  navigate,
  regionMotion,
  teammateUp,
  teleport,
  trackQuest,
  mapQuestMarkers,
  mapWaypoints,
  hudDistance,
  healthFill,
} from './routines.mjs';

const SCREEN = { width: 40, height: 20 };
const flat = (value, stripe = 0) => {
  const pixels = Buffer.alloc(40 * 20 * 3, value);
  pixels.fill(stripe, 12 * 40 * 3, 13 * 40 * 3); // Row 12 lies outside the minimap.
  return { width: 40, height: 20, channels: 3, pixels };
};

// Frames alternate brightness so the minimap "moves" unless a frame repeats the previous value.
// Every frame changes the rest of the screen, as a rendering game does.
function harness(frames, routine = {}, frozen = false) {
  const touches = [];
  let clock = 0,
    i = 0;
  const ctx = {
    routine: {
      id: 'explore',
      screens: ['world', 'climbing', 'prompts'],
      stopScreens: ['prompts'],
      recover: { climbing: 'attack' },
      stuckButton: 'jump',
      maxMs: 10_000,
      ...routine,
    },
    screen: SCREEN,
    joystick: { x: 10, y: 15, radius: 4 },
    minimap: { left: 0, top: 0, right: 10, bottom: 10 },
    buttonCenter: (id) => ({ attack: { x: 35, y: 15 }, jump: { x: 38, y: 12 } })[id],
    frame: async () => {
      clock += 1000;
      const [screen, value] = frames[Math.min(i, frames.length - 1)];
      return { screen, image: flat(value, frozen ? 0 : i++ % 200) };
    },
    touch: async (event, x, y) => touches.push([event, x, y]),
    sleep: async (ms) => (clock += ms),
    now: () => clock,
    random: () => 0.25,
  };
  return { ctx, touches };
}

const held = (touches) =>
  touches.reduce((n, [event]) => n + (event === 'down') - (event === 'up'), 0);

test('hop explore with forwardDeg keeps walking roughly where the camera faces', async () => {
  const frames = Array.from({ length: 8 }, (_, k) => ['world', k % 2 ? 60 : 10]);
  const { ctx, touches } = harness(frames, { hopMs: 500, hops: 5, forwardDeg: 60 });
  ctx.random = (() => {
    let k = 0;
    return () => [0, 1, 0.5, 0.9, 0.1, 0.7][k++ % 6];
  })();
  const result = await explore(ctx);
  assert.equal(result.status, 'walked');
  // Every push stays within 30° of straight up from the joystick centre (10, 15).
  for (const [, x, y] of touches.filter(([event]) => event === 'move')) {
    const deg = (Math.atan2(15 - y, x - 10) * 180) / Math.PI;
    assert.ok(deg >= 55 && deg <= 125, `push at ${deg}°`);
  }
});

test('regionMotion compares a screen-space region of two frames', () => {
  assert.equal(
    regionMotion(flat(10), flat(10), { left: 0, top: 0, right: 10, bottom: 10 }, SCREEN),
    0,
  );
  assert.equal(
    regionMotion(flat(10), flat(40), { left: 0, top: 0, right: 10, bottom: 10 }, SCREEN),
    30,
  );
});

test('explore walks until an interaction prompt appears and releases the joystick', async () => {
  const { ctx, touches } = harness([
    ['world', 0],
    ['world', 50],
    ['world', 100],
    ['prompts', 150],
  ]);
  const result = await explore(ctx);
  assert.equal(result.status, 'found');
  assert.equal(result.screen, 'prompts');
  assert.equal(result.frames, 3);
  assert.deepEqual(touches[0], ['down', 10, 15]);
  assert.equal(touches[1][0], 'move');
  assert.equal(touches.at(-1)[0], 'up');
  assert.equal(held(touches), 0);
});

test('explore started beside a prompt only stops at a prompt after leaving it', async () => {
  const { ctx } = harness([
    ['prompts', 0],
    ['prompts', 50],
    ['world', 100],
    ['prompts', 150],
  ]);
  const result = await explore(ctx);
  assert.equal(result.status, 'found');
  assert.equal(result.frames, 3);
});

test('explore jumps and turns when the minimap stops moving, then gives up', async () => {
  const { ctx, touches } = harness([['world', 7]]);
  const result = await explore(ctx);
  assert.equal(result.status, 'stuck');
  assert.equal(result.stuck, 3);
  const jumps = touches.filter(([event, x]) => event === 'down' && x === 38);
  assert.equal(jumps.length, 2);
  assert.equal(held(touches), 0);
});

test('explore drops from a climb and walks the other way', async () => {
  const { ctx, touches } = harness([
    ['world', 0],
    ['climbing', 50],
    ['world', 100],
    ['world', 150],
    ['prompts', 200],
  ]);
  const result = await explore(ctx);
  assert.equal(result.status, 'found');
  assert.equal(result.recoveries, 1);
  assert.ok(touches.some(([event, x]) => event === 'down' && x === 35));
  assert.equal(held(touches), 0);
});

test('explore keeps climbing up for recoverAfter frames before dropping', async () => {
  const { ctx, touches } = harness(
    [
      ['world', 0],
      ['climbing', 50],
      ['climbing', 100],
      ['world', 150],
      ['world', 200],
      ['prompts', 250],
    ],
    { recoverAfter: 3 },
  );
  const result = await explore(ctx);
  assert.equal(result.status, 'found');
  assert.equal(result.recoveries, 0);
  assert.ok(!touches.some(([event, x]) => event === 'down' && x === 35));
  // Climbing pushes the joystick straight up.
  assert.ok(touches.some(([event, x, y]) => event === 'move' && x === 10 && y === 11));
});

test('explore stops when the screen leaves the open world or at its time limit', async () => {
  let { ctx } = harness([
    ['world', 0],
    ['menu', 50],
  ]);
  assert.deepEqual(
    [
      (await explore(ctx)).status,
      (
        await explore(
          harness([
            ['world', 0],
            [null, 1],
          ]).ctx,
        )
      ).status,
    ],
    ['interrupted', 'interrupted'],
  );
  const frames = Array.from({ length: 20 }, (_, n) => ['world', (n * 50) % 250]);
  ({ ctx } = harness(frames, { maxMs: 4000 }));
  const result = await explore(ctx);
  assert.equal(result.status, 'timeout');
  assert.ok(result.frames <= 4);
});

test('explore reports a game that stopped rendering instead of a stuck character', async () => {
  const { ctx, touches } = harness([['world', 7]], {}, true);
  const result = await explore(ctx);
  assert.equal(result.status, 'frozen');
  assert.equal(held(touches), 0);
});

test('explore confirms a prompt at rest and steps back once when it overshot', async () => {
  // Prompt seen while moving, gone at rest, back after the step back.
  let { ctx, touches } = harness([
    ['world', 0],
    ['prompts', 50],
    ['world', 100],
    ['prompts', 150],
  ]);
  let result = await explore(ctx);
  assert.equal(result.status, 'found');
  assert.equal(result.backsteps, 1);
  assert.equal(held(touches), 0);
  // Still gone after the step back: keep exploring instead of reporting a find.
  ({ ctx, touches } = harness([
    ['world', 0],
    ['prompts', 50],
    ['world', 100],
    ['world', 150],
    ['world', 200],
    ['world', 250],
    ['prompts', 0],
    ['prompts', 50],
  ]));
  result = await explore(ctx);
  assert.equal(result.status, 'found');
  assert.equal(result.overshoots, 1);
  assert.equal(held(touches), 0);
});

test('explore turns back once when it walks into water', async () => {
  const { ctx } = harness(
    [
      ['world', 0],
      ['world', 50],
      ['water', 100],
      ['prompts', 200],
    ],
    { screens: ['world', 'water'], turnScreens: ['water'] },
  );
  const result = await explore(ctx);
  assert.equal(result.status, 'found');
  assert.equal(result.turns, 1);
});

test('explore releases the joystick when a frame fails', async () => {
  const { ctx, touches } = harness([['world', 0]]);
  let calls = 0;
  const frame = ctx.frame;
  ctx.frame = async () => {
    if (++calls === 2) throw new Error('capture failed');
    return frame();
  };
  await assert.rejects(explore(ctx), /capture failed/);
  assert.equal(held(touches), 0);
});

test('hop mode checks each frame at rest and reports a prompt reached on a hop', async () => {
  const { ctx, touches } = harness(
    [
      ['world', 0],
      ['world', 50],
      ['world', 100],
      ['prompts', 150],
    ],
    { hopMs: 700, hops: 5 },
  );
  const result = await explore(ctx);
  assert.deepEqual(
    [result.status, result.hops, result.frames, result.moved],
    ['found', 3, 3, true],
  );
  // Every hop presses, holds for hopMs and releases before the frame is read.
  const downs = touches.filter(([event, x]) => event === 'down' && x === 10);
  assert.equal(downs.length, 3);
  assert.equal(held(touches), 0);
});

test('hop mode walks a bounded number of hops, then reports it moved', async () => {
  const frames = Array.from({ length: 10 }, (_, n) => ['world', (n * 50) % 250]);
  let { ctx, touches } = harness(frames, { hopMs: 700, hops: 4 });
  let result = await explore(ctx);
  assert.deepEqual([result.status, result.hops, result.moved], ['walked', 4, true]);
  assert.equal(held(touches), 0);
  // Started beside a prompt that stays in reach: not a new find.
  ({ ctx } = harness(
    [
      ['prompts', 0],
      ['prompts', 50],
      ['prompts', 100],
    ],
    { hopMs: 700, hops: 2 },
  ));
  assert.equal((await explore(ctx)).status, 'walked');
  // Hops that do not move the minimap jump, turn and finally give up without progress.
  ({ ctx, touches } = harness([['world', 7]], { hopMs: 700, hops: 10 }));
  result = await explore(ctx);
  assert.deepEqual([result.status, result.stuck, result.moved], ['stuck', 3, false]);
  assert.equal(touches.filter(([event, x]) => event === 'down' && x === 38).length, 2);
  assert.equal(held(touches), 0);
});

function script(frames, routine, extra = {}) {
  const touches = [];
  let clock = 0,
    i = 0;
  const ctx = {
    routine,
    screen: SCREEN,
    buttonCenter: (id) =>
      ({ next: { x: 20, y: 18 }, attack: { x: 35, y: 15 } })[id] ?? { x: 1, y: 1 },
    frame: async () => {
      clock += 1000;
      const [screen, value, changes = true] = frames[Math.min(i, frames.length - 1)];
      return { screen, image: flat(value, changes ? i++ % 200 : (i++, 0)) };
    },
    touch: async (event, x, y) => touches.push([event, x, y]),
    sleep: async (ms) => (clock += ms),
    now: () => clock,
    ...extra,
  };
  return { ctx, touches };
}

const DIALOGUE = {
  id: 'dialogue',
  screens: ['dialogue'],
  stopScreens: ['choice'],
  doneScreens: ['world'],
  button: 'next',
  unknownLimit: 2,
};

test('dialogue taps through lines and hands reply options back to Jev', async () => {
  const { ctx, touches } = script(
    [
      ['dialogue', 0],
      ['dialogue', 10],
      [null, 0],
      ['dialogue', 20],
      ['choice', 30],
    ],
    DIALOGUE,
  );
  const result = await dialogue(ctx);
  assert.equal(result.status, 'choice');
  assert.equal(result.taps, 3); // No tap on the unknown fade frame.
  assert.deepEqual(touches[0], ['down', 20, 18]);
  const ended = await dialogue(
    script(
      [
        ['dialogue', 0],
        ['world', 5],
      ],
      DIALOGUE,
    ).ctx,
  );
  assert.deepEqual([ended.status, ended.screen, ended.taps], ['done', 'world', 1]);
});

test('dialogue stops on a hung game, long fades, other screens and its time limit', async () => {
  const hung = script([['dialogue', 0, false]], DIALOGUE);
  assert.equal((await dialogue(hung.ctx)).status, 'frozen');
  assert.equal((await dialogue(script([[null, 0]], DIALOGUE).ctx)).status, 'interrupted');
  const menu = await dialogue(
    script(
      [
        ['dialogue', 0],
        ['menu', 5],
      ],
      DIALOGUE,
    ).ctx,
  );
  assert.deepEqual([menu.status, menu.screen], ['interrupted', 'menu']);
  const long = await dialogue(script([['dialogue', 0]], { ...DIALOGUE, maxMs: 5000 }).ctx);
  assert.equal(long.status, 'timeout');
});

const COMBAT = {
  id: 'combat',
  screens: ['world'],
  attack: 'attack',
  skill: 'skill',
  burst: 'burst',
  switchButtons: ['t1', 't2', 't3'],
  attackTaps: 2,
  maxMs: 20_000,
};

test('combat rotates skill, burst, attacks and teammates until the time limit', async () => {
  const { ctx, touches } = script([['world', 0]], COMBAT);
  const result = await combat(ctx);
  assert.equal(result.status, 'timeout');
  assert.ok(result.rounds >= 3);
  assert.equal(result.switches, result.rounds);
  // One round: skill, burst, two attacks and one switch, each a down/up pair.
  assert.equal(touches.length, result.rounds * 5 * 2);
  assert.equal(held(touches), 0);
  const menu = await combat(
    script(
      [
        ['world', 0],
        ['menu', 5],
      ],
      COMBAT,
    ).ctx,
  );
  assert.deepEqual([menu.status, menu.rounds], ['interrupted', 1]);
  assert.equal((await combat(script([['world', 0, false]], COMBAT).ctx)).status, 'frozen');
});

// A flat 200 frame fills the search box with one 40x10 ar.
const ENEMY = {
  bounds: { left: 0, top: 0, right: 40, bottom: 10 },
  rgb: [200, 200, 200],
  tolerance: 10,
  minWidth: 16,
  maxHeight: 12,
  nearWidth: 30,
  scale: 1,
};

test('combat with an enemy HP bar stops when no enemy is left', async () => {
  const enemy = { enemy: ENEMY };
  const frames = [
    ['world', 200],
    ['world', 200],
    ['world', 0],
    ['world', 0],
  ];
  const cleared = await combat(script(frames, COMBAT, enemy).ctx);
  assert.equal(cleared.status, 'clear');
  assert.equal(cleared.rounds, 3);
  assert.ok(cleared.enemy[0] > 0 && cleared.enemy.at(-1) === 0);
  const none = await combat(script([['world', 0]], COMBAT, enemy).ctx);
  assert.deepEqual([none.status, none.rounds], ['no_enemy', 1]);
  // HP bars that only appear once the first round hits still count as a fight.
  const late = await combat(
    script(
      [
        ['world', 0],
        ['world', 200],
        ['world', 0],
        ['world', 0],
      ],
      COMBAT,
      enemy,
    ).ctx,
  );
  assert.deepEqual([late.status, late.rounds], ['clear', 3]);
});

test('combat skips downed teammates and closes the revive dialog', async () => {
  // Grey frames: every portrait reads grey at once, which is a panel faded by a skill animation
  // far more often than a fully downed party, so the rotation switches anyway.
  const alivePortrait = { dx: 0, dy: 0, w: 6, h: 6, minSaturation: 70, minPixels: 4 };
  const grey = await combat(script([['world', 0]], { ...COMBAT, alivePortrait }).ctx);
  assert.equal(grey.switches, grey.rounds);
  assert.equal(grey.downed, 0);
  assert.equal(grey.faded, grey.rounds);
  const image = flat(0);
  for (let y = 2; y < 8; y++)
    for (let x = 27; x < 33; x++) image.pixels.set([220, 40, 40], (y * 40 + x) * 3);
  assert.ok(teammateUp(image, SCREEN, { x: 30, y: 5 }, alivePortrait));
  assert.ok(!teammateUp(image, SCREEN, { x: 5, y: 5 }, alivePortrait));
  // Only row 3 is in colour: rows 1 and 2 are skipped as downed and row 3 is switched in.
  const partial = script([['world', 0]], { ...COMBAT, alivePortrait, maxMs: 1 });
  partial.ctx.buttonCenter = (id) =>
    ({ t1: { x: 5, y: 5 }, t2: { x: 15, y: 5 }, t3: { x: 30, y: 5 } })[id] ?? { x: 1, y: 1 };
  partial.ctx.frame = async () => ({ screen: 'world', image });
  const one = await combat(partial.ctx);
  assert.deepEqual(one.downRows, ['1:t1', '1:t2']);
  assert.equal(one.switches, 1);
  assert.equal(one.faded, undefined);
  // A revive dialog (switching to a downed teammate) is cancelled and the fight goes on.
  const { ctx, touches } = script(
    [
      ['world', 0],
      ['revive', 5],
      ['world', 0],
      ['menu', 5],
    ],
    { ...COMBAT, recover: { revive: 'cancel' } },
  );
  ctx.buttonCenter = (id) => (id === 'cancel' ? { x: 9, y: 9 } : { x: 1, y: 1 });
  const revived = await combat(ctx);
  assert.deepEqual([revived.status, revived.recoveries, revived.rounds], ['interrupted', 1, 2]);
  assert.equal(touches.filter(([e, x, y]) => e === 'down' && x === 9 && y === 9).length, 1);
});

test('combat revives a downed teammate with food and reports when food runs out', async () => {
  const alivePortrait = { dx: 0, dy: 0, w: 6, h: 6, minSaturation: 70, minPixels: 4 };
  const image = flat(0);
  for (let y = 2; y < 8; y++)
    for (let x = 27; x < 33; x++) image.pixels.set([220, 40, 40], (y * 40 + x) * 3);
  const revive = { screen: 'revive', confirm: 'ok', cancel: 'cancel' };
  const { ctx, touches } = script([['world', 0]], {
    ...COMBAT,
    alivePortrait,
    revive,
    recover: { revive: 'cancel' },
    maxMs: 1,
  });
  const centers = {
    t1: { x: 5, y: 5 },
    t2: { x: 15, y: 5 },
    t3: { x: 30, y: 5 },
    ok: { x: 11, y: 9 },
    cancel: { x: 9, y: 9 },
  };
  ctx.buttonCenter = (id) => centers[id] ?? { x: 1, y: 1 };
  // t1 opens the dialog and food revives it; t2 opens it, confirm leaves it open (no food).
  const screens = ['world', 'revive', 'world', 'revive', 'revive', 'world'];
  ctx.frame = async () => ({ screen: screens.shift() ?? 'world', image });
  const result = await combat(ctx);
  assert.equal(result.revived, 1);
  assert.equal(result.noFood, true);
  assert.equal(result.reviveTries, 2);
  assert.equal(result.switches, 1);
  const downs = (c) => touches.filter(([e, x, y]) => e === 'down' && x === c.x && y === c.y);
  assert.equal(downs(centers.ok).length, 2);
  assert.equal(downs(centers.cancel).length, 1);
  assert.equal(downs(centers.t3).length, 1);
});

const MAP = { left: 10, top: 10, right: 90, bottom: 90 };
const MAP_SCREEN = { width: 120, height: 100 };
const YELLOW = { rgb: [251, 232, 2], tolerance: 30 };
// A minimap with a brighter 85° view cone at `cone` degrees, an optional yellow marker and
// corners whose shade changes with `tick` so consecutive frames differ like a moving map.
// `ground` [x, y] draws textured terrain seen from that position, so the map scrolls with it.
function mapImage({ cone, marker, ring, diamond, bang, ground, hud, tick = 0 }) {
  const { width, height } = MAP_SCREEN;
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const dx = x - 50,
        dy = y - 50,
        r = Math.hypot(dx, dy);
      const deg = (Math.atan2(-dy, dx) * 180) / Math.PI;
      const off = Math.abs(((((deg - cone + 180) % 360) + 360) % 360) - 180);
      let rgb = [60, 60, 60];
      if (r > 40) rgb = [(tick * 40) % 200, 60, 60];
      if (ground) {
        const gx = x + ground[0],
          gy = y + ground[1];
        rgb = [((gx * 37 + gy * 91) ^ (gx * gy)) & 127, (gx * 13 + gy * 7) & 127, 60];
      } else if (off <= 42 && r > 6) rgb = [110, 110, 110];
      if (marker) {
        const mx = 50 + marker.r * 40 * Math.cos((marker.deg * Math.PI) / 180),
          my = 50 - marker.r * 40 * Math.sin((marker.deg * Math.PI) / 180);
        if (Math.hypot(x - mx, y - my) <= 3) rgb = marker.rgb ?? [251, 232, 2];
      }
      // The tracked quest's HUD icon (outside the minimap), in `hud` colour.
      if (hud && x >= 100 && x < 110 && y >= 90 && y < 100) rgb = hud;
      // A quest-area outline (radius `ring.radius` half-widths) with a gap from `ring.gap` deg.
      if (ring) {
        const rx = 50 + ring.r * 40 * Math.cos((ring.deg * Math.PI) / 180),
          ry = 50 - ring.r * 40 * Math.sin((ring.deg * Math.PI) / 180);
        const d = Math.hypot(x - rx, y - ry);
        const at = (Math.atan2(-(y - ry), x - rx) * 180) / Math.PI;
        const inGap = Math.abs(((((at - ring.gap + 180) % 360) + 360) % 360) - 180) < 50;
        if (Math.abs(d - ring.radius * 40) <= 1.5 && !inGap) rgb = ring.rgb ?? [251, 232, 2];
      }
      // A gold quest diamond floating in the 3D view, outside the minimap.
      if (diamond && Math.abs(x - diamond[0]) <= 3 && Math.abs(y - diamond[1]) <= 3)
        rgb = [233, 180, 13];
      // A blue "!" quest icon in the 3D view: a 7×19 glow outline around a white core, or a solid
      // blue patch (blue rock, sky) when `bang[2]` is 'solid'.
      if (bang && Math.abs(x - bang[0]) <= 3 && Math.abs(y - bang[1]) <= 9) {
        const rim = Math.abs(x - bang[0]) === 3 || Math.abs(y - bang[1]) === 9;
        rgb = rim || bang[2] === 'solid' ? [95, 145, 229] : [235, 240, 255];
      }
      pixels.set(rgb, (y * width + x) * 3);
    }
  return { width, height, channels: 3, pixels };
}

test('markerBearing and coneHeading read the minimap in screen angles', () => {
  const image = mapImage({ cone: 30, marker: { deg: 135, r: 0.8 } });
  const marker = markerBearing(image, MAP_SCREEN, MAP, YELLOW, 1.35);
  assert.ok(Math.abs(marker.deg - 135) < 5, `marker at ${marker.deg}`);
  assert.ok(Math.abs(marker.r - 0.8) < 0.1);
  const cone = coneHeading(image, MAP_SCREEN, MAP);
  assert.ok(Math.abs(cone.deg - 30) <= 5, `cone at ${cone.deg}`);
  assert.ok(cone.contrast > 20);
  assert.equal(markerBearing(mapImage({ cone: 30 }), MAP_SCREEN, MAP, YELLOW, 1.35), null);
});

test('markerBearing follows the quest icon, not stray terrain specks of a similar colour', () => {
  const speck = (image, x0, y0, rgb) => {
    for (let y = y0; y < y0 + 4; y++)
      for (let x = x0; x < x0 + 4; x++) image.pixels.set(rgb, (y * image.width + x) * 3);
    return image;
  };
  const PURPLE = { ...YELLOW, colors: [{ rgb: [182, 155, 232], hud: {} }] };
  const terrain = [215, 190, 60];
  const story = speck(
    speck(
      mapImage({ cone: 30, marker: { deg: 135, r: 0.7, rgb: [182, 155, 232] } }),
      70,
      30,
      terrain,
    ),
    66,
    56,
    terrain,
  );
  const tracked = markerBearing(
    story,
    MAP_SCREEN,
    MAP,
    { ...PURPLE, min: [180, 120, 0], max: [255, 255, 90] },
    1.35,
  );
  assert.ok(Math.abs(tracked.deg - 135) < 5, `purple icon at ${tracked.deg}`);
  assert.ok(Math.abs(tracked.r - 0.7) < 0.1);
  // Without a tracked colour the largest blob wins over a smaller speck.
  const main = speck(mapImage({ cone: 30, marker: { deg: 45, r: 0.6 } }), 26, 60, terrain);
  const icon = markerBearing(
    main,
    MAP_SCREEN,
    MAP,
    { ...YELLOW, min: [180, 120, 0], max: [255, 255, 90] },
    1.35,
  );
  assert.ok(Math.abs(icon.deg - 45) < 5, `yellow icon at ${icon.deg}`);
});

function navHarness(frames, routine = {}) {
  const touches = [];
  let clock = 0,
    i = 0;
  const ctx = {
    routine: {
      id: 'navigate',
      screens: ['world', 'talk'],
      stopScreens: ['talk'],
      marker: YELLOW,
      maxMs: 20_000,
      ...routine,
    },
    screen: MAP_SCREEN,
    joystick: { x: 20, y: 80, radius: 10 },
    minimap: MAP,
    camera: { x: 80, y: 40, degreesPerPixel: 0.45, deadzone: 22, maxDrag: 420 },
    buttonCenter: () => ({ x: 100, y: 90 }),
    frame: async () => {
      clock += 200;
      const f = frames[Math.min(i, frames.length - 1)];
      i++;
      return {
        screen: f.screen ?? 'world',
        image: mapImage({ ...f, tick: f.tick ?? i }),
        damaged: f.damaged,
      };
    },
    touch: async (event, x, y) => touches.push([event, x, y]),
    sleep: async (ms) => (clock += ms),
    now: () => clock,
  };
  return { ctx, touches };
}

test('navigate turns the camera toward the marker, runs, and stops on arrival', async () => {
  const { ctx, touches } = navHarness([
    { cone: 0, marker: { deg: 90, r: 1.2 } },
    { cone: 90, marker: { deg: 90, r: 1.2 } },
    { cone: 90, marker: { deg: 90, r: 0.9 } },
    { cone: 90, marker: { deg: 90, r: 0.05 } },
  ]);
  const result = await navigate(ctx);
  assert.equal(result.status, 'arrived');
  assert.equal(result.drags, 1);
  // Marker 90° counter-clockwise of the cone: drag left by 90 / 0.45 + deadzone pixels.
  const drag = touches.findIndex(([event, x, y]) => event === 'down' && x === 80 && y === 40);
  const up = touches.slice(drag).find(([event]) => event === 'up');
  assert.ok(up[1] < 80 - 200 && up[1] > 80 - 240, `drag ended at ${up[1]}`);
  assert.ok(touches.some(([event, x, y]) => event === 'move' && x === 20 && y === 70));
  assert.equal(held(touches), 0);
  assert.equal(result.moved, true);
});

test('navigate first sidesteps when the last walk was blocked', async () => {
  const { ctx, touches } = navHarness([{ cone: 0, marker: { deg: 0, r: 0.05 } }], {
    sidestepMs: 1000,
  });
  ctx.sidestep = 'left';
  const result = await navigate(ctx);
  assert.deepEqual([result.status, result.sidestep], ['arrived', 'left']);
  assert.deepEqual(touches.slice(0, 3), [
    ['down', 20, 80],
    ['move', 10, 80],
    ['up', 10, 80],
  ]);
  const right = navHarness([{ cone: 0, marker: { deg: 0, r: 0.05 } }], { sidestepMs: 1000 });
  right.ctx.sidestep = 'right';
  await navigate(right.ctx);
  assert.deepEqual(right.touches[1], ['move', 30, 80]);
});

test('navigate keeps walking past maxMs while the HUD quest distance keeps shrinking', async () => {
  const run = async (readings) => {
    const { ctx } = navHarness([{ cone: 90, marker: { deg: 90, r: 1.2 } }], {
      marker: { ...YELLOW, icons: { distance: { x: 0, y: 0, w: 10, h: 5 } } },
      maxMs: 2000,
      extendMs: 2000,
      extendMetres: 10,
      extendMaxMs: 7000,
    });
    ctx.rect = () => ({ left: 0, top: 0, right: 10, bottom: 5 });
    let n = 0;
    ctx.readText = async () => `${readings[Math.min(n++, readings.length - 1)]}m`;
    return navigate(ctx);
  };
  const closing = await run([200, 180, 160, 140, 120, 100]);
  assert.equal(closing.status, 'timeout');
  assert.equal(closing.extensions, 3);
  const stalled = await run([200, 195]);
  assert.deepEqual(
    [stalled.status, stalled.extensions, stalled.toMetres],
    ['timeout', undefined, 195],
  );
});

test('navigate double-taps jump now and then while walking, but not while airborne', async () => {
  const run = (screen) => {
    const { ctx, touches } = navHarness([{ cone: 90, marker: { deg: 90, r: 1.2 }, screen }], {
      screens: ['world', 'glide', 'talk'],
      maxMs: 6000,
      jumpButton: 'jump',
      jumpEvery: 1000,
      jumpGapMs: 100,
      airScreens: ['glide'],
    });
    return navigate(ctx).then((result) => ({ result, touches }));
  };
  const taps = (touches) =>
    touches.filter(([event, x, y]) => event === 'down' && x === 100 && y === 90).length;
  const walking = await run('world');
  assert.equal(walking.result.status, 'timeout');
  assert.ok(walking.result.jumps >= 2, `jumped ${walking.result.jumps} times`);
  assert.equal(taps(walking.touches), walking.result.jumps * 2);
  const gliding = await run('glide');
  assert.equal(gliding.result.status, 'timeout');
  assert.equal(gliding.result.jumps, undefined);
  assert.equal(taps(gliding.touches), 0);
  assert.ok(gliding.touches.some(([event, x, y]) => event === 'move' && x === 20 && y === 70));
  assert.equal(held(gliding.touches), 0);
});

test('navigate follows a purple quest marker only while the HUD quest icon is purple', async () => {
  const PURPLE = [182, 155, 232];
  const marker = {
    ...YELLOW,
    colors: [{ rgb: PURPLE, tolerance: 30, hud: { x: 105, y: 95, w: 10, h: 10 } }],
  };
  const purple = { deg: 0, r: 0.02, rgb: PURPLE };
  const rect = (e) => ({
    left: e.x - e.w / 2,
    top: e.y - e.h / 2,
    right: e.x + e.w / 2,
    bottom: e.y + e.h / 2,
  });
  const tracked = navHarness([{ cone: 0, marker: purple, hud: PURPLE }], { marker });
  tracked.ctx.rect = rect;
  assert.equal((await navigate(tracked.ctx)).status, 'arrived');
  // Untracked purple quests also show on the minimap: ignored while the HUD icon is not purple.
  const other = navHarness([{ cone: 0, marker: purple, hud: [90, 140, 230] }], { marker });
  other.ctx.rect = rect;
  assert.equal((await navigate(other.ctx)).status, 'no_marker');
});

test('navigate reports a missing marker, a hidden cone and stop screens', async () => {
  assert.equal((await navigate(navHarness([{ cone: 0 }]).ctx)).status, 'no_marker');
  // With `revealButton` a hidden marker gets one tap on the quest title, then a fresh look.
  const hidden = navHarness([{ cone: 0 }, { cone: 0, marker: { deg: 0, r: 0.02 } }], {
    revealButton: 'quest_objective',
  });
  const revealed = await navigate(hidden.ctx);
  assert.deepEqual([revealed.status, revealed.reveals], ['arrived', 1]);
  assert.deepEqual(hidden.touches.slice(0, 2), [
    ['down', 100, 90],
    ['up', 100, 90],
  ]);
  const gone = navHarness([{ cone: 0 }], { revealButton: 'quest_objective' });
  const twice = await navigate(gone.ctx);
  assert.deepEqual([twice.status, twice.reveals], ['no_marker', 1]);
  const flatCone = navHarness([{ cone: 0, marker: { deg: 0, r: 1.2 } }], {
    cone: { minContrast: 1000 },
  });
  assert.equal((await navigate(flatCone.ctx)).status, 'no_camera');
  const { ctx, touches } = navHarness([
    { cone: 0, marker: { deg: 0, r: 1.2 } },
    { cone: 0, marker: { deg: 0, r: 1.1 }, screen: 'talk' },
  ]);
  const talk = await navigate(ctx);
  assert.deepEqual([talk.status, talk.screen], ['found', 'talk']);
  assert.equal(held(touches), 0);
});

test('navigate walks past a sit-down prompt instead of stopping at it', async () => {
  const frames = [
    { cone: 0, marker: { deg: 0, r: 1.2 } },
    { cone: 0, marker: { deg: 0, r: 1.1 }, screen: 'talk' },
    { cone: 0, marker: { deg: 0, r: 0.05 }, screen: 'talk' },
  ];
  const ignorePrompt = { x: 60, y: 50, w: 20, h: 10, match: '坐下' };
  const rect = (e) => ({
    left: e.x - e.w / 2,
    top: e.y - e.h / 2,
    right: e.x + e.w / 2,
    bottom: e.y + e.h / 2,
  });
  const seat = navHarness(frames, { ignorePrompt });
  seat.ctx.rect = rect;
  seat.ctx.readText = async () => '坐下';
  const walked = await navigate(seat.ctx);
  assert.deepEqual([walked.status, walked.ignoredPrompt], ['arrived', '坐下']);
  const npc = navHarness(frames, { ignorePrompt });
  npc.ctx.rect = rect;
  npc.ctx.readText = async () => '菲尔戈黛特';
  assert.equal((await navigate(npc.ctx)).status, 'found');
});

test('navigate steers by the quest diamond in view once the minimap marker is close', async () => {
  const screenMarker = {
    rgb: [233, 180, 13],
    tolerance: 10,
    pixels: [40, 60],
    size: [6, 8],
    radius: 0.35,
    viewDegreesPerPixel: 1,
    turnDeg: 8,
  };
  const frames = [
    { cone: 0, marker: { deg: 0, r: 0.05 }, diamond: [105, 20] },
    { cone: 0, marker: { deg: 0, r: 0.05 }, diamond: [60, 20], screen: 'talk' },
  ];
  // Without it the close marker counts as arrival, though the NPC is still metres away.
  assert.equal((await navigate(navHarness(frames).ctx)).status, 'arrived');
  const { ctx, touches } = navHarness(frames, { screenMarker, arriveRadius: 0.03 });
  const result = await navigate(ctx);
  assert.deepEqual([result.status, result.close, result.drags], ['found', 1, 1]);
  // Diamond 45 px right of centre: the camera turns right (drag ends right of its start).
  const drag = touches.findIndex(([event, x, y]) => event === 'down' && x === 80 && y === 40);
  assert.ok(touches.slice(drag).find(([event]) => event === 'up')[1] > 80);
  assert.equal(held(touches), 0);
});

test('navigate steers by a blue "!" icon in view, even inside a misread quest-area ring', async () => {
  const screenMarker = {
    markers: [
      { rgb: [233, 180, 13], tolerance: 10, pixels: [40, 60], size: [6, 8] },
      {
        rgb: [95, 145, 229],
        tolerance: 10,
        pixels: [40, 60],
        w: [6, 8],
        h: [18, 20],
        core: { min: 200, share: 0.5 },
      },
    ],
    radius: 0.35,
    viewDegreesPerPixel: 1,
    turnDeg: 8,
  };
  const options = {
    screenMarker,
    marker: { ...YELLOW, area: {} },
    areaWaitMs: 2000,
    areaCircleMs: 2000,
    areaHopMs: 1000,
  };
  const ring = { deg: 45, r: 0.2, radius: 0.5, gap: 200 };
  const frames = (bang) => [
    { cone: 0, ring, bang },
    { cone: 0, ring, bang: [60, 20, bang[2]], screen: 'talk' },
  ];
  const { ctx, touches } = navHarness(frames([105, 20]), options);
  const result = await navigate(ctx);
  assert.deepEqual([result.status, result.close, result.drags], ['found', 1, 1]);
  const drag = touches.findIndex(([event, x, y]) => event === 'down' && x === 80 && y === 40);
  assert.ok(touches.slice(drag).find(([event]) => event === 'up')[1] > 80);
  // A solid blue patch without the white core is no icon: the ring is searched as before.
  const solid = await navigate(navHarness(frames([105, 20, 'solid']), options).ctx);
  assert.equal(solid.close, undefined);
  assert.deepEqual([solid.status, solid.area], ['arrived', 'changed']);
});

test('markerBearing fits a quest-area ring so a hidden arc does not move its centre', () => {
  const AREA = { ...YELLOW, area: {} };
  const image = mapImage({ cone: 0, ring: { deg: 45, r: 0.3, radius: 0.5, gap: 200 } });
  const centroid = markerBearing(image, MAP_SCREEN, MAP, YELLOW, 1.35);
  const fitted = markerBearing(image, MAP_SCREEN, MAP, AREA, 1.35);
  assert.ok(Math.abs(fitted.deg - 45) < 5, `ring centre at ${fitted.deg}`);
  assert.ok(Math.abs(fitted.r - 0.3) < 0.05, `ring centre r ${fitted.r}`);
  assert.ok(Math.abs(fitted.area.radius - 0.5) < 0.05);
  // The plain centroid is pulled away from the gap.
  assert.ok(Math.abs(centroid.r - 0.3) > 0.1, `centroid r ${centroid.r}`);
  // A compact icon is not an area.
  const icon = mapImage({ cone: 0, marker: { deg: 135, r: 0.8 } });
  assert.equal(markerBearing(icon, MAP_SCREEN, MAP, AREA, 1.35).area, undefined);
  // A circle wider than the minimap is stray arcs, not a quest area (it faked an arrival).
  const wide = mapImage({ cone: 0, ring: { deg: 0, r: 0.1, radius: 1.2, gap: 200 } });
  assert.equal(markerBearing(wide, MAP_SCREEN, MAP, AREA, 1.35).area, undefined);
  const capped = { ...YELLOW, area: { maxRadius: 1 } };
  assert.equal(markerBearing(image, MAP_SCREEN, MAP, capped, 1.35).area.radius < 1, true);
  // A quest icon at the minimap edge (row runs [y, x0, x1] read off a phone frame) fitted a
  // circle 0.86 half-widths wide that its pixels cover only a short arc of.
  const W = 400,
    H = 300,
    edge = Buffer.alloc(W * H * 3, 60);
  for (const [y, x0, x1] of EDGE_ICON)
    for (let x = x0; x <= x1; x++) edge.set([251, 232, 2], (y * W + x) * 3);
  const edgeImage = { width: W, height: H, channels: 3, pixels: edge };
  const phone = [
    { width: W, height: H },
    { left: 210, right: 390, top: 60, bottom: 240 },
  ];
  const edgeArea = (area) => markerBearing(edgeImage, ...phone, { ...YELLOW, area }, 1.35);
  assert.equal(edgeArea({}).area, undefined);
  assert.ok(edgeArea({}).r > 1);
  assert.ok(edgeArea({ minArc: 0.01 }).area.radius > 0.8);
});

// prettier-ignore
const EDGE_ICON = [[49,234,236],[50,233,237],[51,232,238],[52,232,238],[53,232,238],[54,231,233],[54,237,238],[55,230,232],[55,237,239],[56,230,231],[56,239,240],[57,228,230],[57,234,235],[57,240,241],[58,227,229],[58,233,236],[58,240,242],[59,226,228],[59,232,237],[59,242,243],[60,223,227],[60,231,238],[60,243,247],[61,222,226],[61,231,239],[61,244,248],[62,221,225],[62,229,240],[62,245,249],[63,221,224],[63,228,241],[63,246,249],[64,220,224],[64,228,241],[64,246,250],[65,221,225],[65,229,241],[65,245,249],[66,222,226],[66,230,240],[66,244,248],[67,223,227],[67,231,239],[67,243,247],[68,226,228],[68,232,238],[68,242,244],[68,246,246],[69,227,229],[69,233,237],[69,241,243],[70,228,230],[70,234,236],[70,240,242],[71,229,231],[71,235,235],[71,239,241],[72,230,232],[72,238,240],[73,231,233],[73,237,239],[74,231,234],[74,236,238],[75,232,238],[76,232,238],[77,233,237],[78,234,236],[79,235,235],[152,381,381]];

test('markerBearing finds a pale translucent area ring next to a bright icon', () => {
  const PALE = { ...YELLOW, area: { min: [170, 150, 60], max: [235, 215, 130] } };
  const pale = { deg: 120, r: 0.2, radius: 0.3, gap: 270, rgb: [205, 188, 108] };
  const image = mapImage({ cone: 0, ring: pale, marker: { deg: -45, r: 1.25 } });
  // The icon colour alone sees only the stray icon outside the ring.
  assert.equal(
    markerBearing(image, MAP_SCREEN, MAP, { ...YELLOW, area: {} }, 1.35).area,
    undefined,
  );
  const fitted = markerBearing(image, MAP_SCREEN, MAP, PALE, 1.35);
  assert.ok(Math.abs(fitted.deg - 120) < 8, `ring centre at ${fitted.deg}`);
  assert.ok(Math.abs(fitted.r - 0.2) < 0.06, `ring centre r ${fitted.r}`);
  // A filled pale patch is not a ring.
  const patch = mapImage({ cone: 0, marker: { deg: -45, r: 1.25 } });
  for (let y = 40; y < 50; y++)
    for (let x = 40; x < 50; x++) patch.pixels.set([205, 188, 108], (y * patch.width + x) * 3);
  assert.equal(markerBearing(patch, MAP_SCREEN, MAP, PALE, 1.35).area, undefined);
});

test('navigate runs into a quest area and arrives near its centre', async () => {
  const { ctx, touches } = navHarness(
    [
      { cone: 45, ring: { deg: 45, r: 0.3, radius: 0.5, gap: 200 } },
      { cone: 45, ring: { deg: 45, r: 0.08, radius: 0.5, gap: 200 } },
    ],
    { marker: { ...YELLOW, area: {} }, arriveRadius: 0.03, areaArrive: 0.25 },
  );
  const result = await navigate(ctx);
  assert.equal(result.status, 'arrived');
  assert.ok(result.marker.area);
  // Full deflection inside an area, not the short near-marker hops.
  assert.ok(touches.some(([event, x, y]) => event === 'move' && x === 20 && y === 70));
  assert.ok(!touches.some(([event, x, y]) => event === 'move' && x === 20 && y === 75));
});

test('navigate waits inside a quest area, then walks circles in it until something changes', async () => {
  const inside = { cone: 45, ring: { deg: 45, r: 0.2, radius: 0.5, gap: 200 } };
  const options = {
    marker: { ...YELLOW, area: {} },
    areaWaitMs: 2000,
    areaCircleMs: 4000,
    areaHopMs: 1000,
  };
  const { ctx, touches } = navHarness([inside], options);
  const searched = await navigate(ctx);
  assert.equal(searched.status, 'searched');
  assert.ok(searched.circles >= 2);
  // Along the ring's tangent: the centre is straight ahead, so the stick points 90° right.
  assert.ok(touches.some(([event, x, y]) => event === 'move' && x === 30 && y === 80));
  assert.equal(held(touches), 0);
  // A new screen or the ring going away ends the search as soon as it is seen.
  for (const later of [{ ...inside, screen: 'talk' }, { cone: 45 }]) {
    const frames = [inside, inside, inside, inside, later];
    const result = await navigate(navHarness(frames, options).ctx);
    assert.deepEqual([result.status, result.area], ['arrived', 'changed']);
  }
});

test('navigate keeps re-aiming for minFrames when frames are slow, within three times maxMs', async () => {
  for (const [minFrames, frames] of [
    [undefined, 3],
    [8, 8],
    [40, 11],
  ]) {
    const { ctx } = navHarness([{ cone: 0, marker: { deg: 0, r: 1.2 } }], {
      ...(minFrames && { minFrames }),
      maxMs: 20_000,
      stuckLimit: 10,
    });
    const frame = ctx.frame;
    ctx.frame = async () => (await ctx.sleep(4800), frame());
    const result = await navigate(ctx);
    assert.equal(result.status, 'timeout');
    assert.equal(result.frames, frames);
    assert.ok(result.ms <= 60_000);
  }
});

test('navigate gives up when the map stops moving', async () => {
  const { ctx } = navHarness([{ cone: 0, marker: { deg: 0, r: 1.2 }, tick: 0 }], {
    stuckLimit: 2,
  });
  const result = await navigate(ctx);
  assert.equal(result.status, 'stuck');
  assert.equal(result.moved, false);
});

test('navigate keeps climbing past recoverAfter while the view keeps changing', async () => {
  // Every climbing frame has a different tick (real progress), so recoverAfter must never fire
  // even though the character stays on the climbing screen for more frames than recoverAfter.
  const { ctx } = navHarness(
    [
      { cone: 0, marker: { deg: 0, r: 1.2 }, screen: 'climbing' },
      { cone: 0, marker: { deg: 0, r: 1.2 }, screen: 'climbing' },
      { cone: 0, marker: { deg: 0, r: 1.2 }, screen: 'climbing' },
      { cone: 0, marker: { deg: 0, r: 1.1 }, screen: 'world' },
      { cone: 0, marker: { deg: 0, r: 0.05 }, screen: 'world' },
    ],
    { recover: { climbing: 'attack' }, recoverAfter: 2 },
  );
  const result = await navigate(ctx);
  assert.equal(result.status, 'arrived');
  assert.equal(result.recoveries, 0);
  assert.equal(result.drags, 0);
});

test('navigate drops and turns only once climbing truly stalls', async () => {
  // Every climbing frame shares the same tick (no visible progress), so recoverAfter should
  // fire once the stall has lasted recoverAfter frames, then resume toward the marker.
  const { ctx } = navHarness(
    [
      { cone: 0, marker: { deg: 0, r: 1.2 }, screen: 'climbing', tick: 5 },
      { cone: 0, marker: { deg: 0, r: 1.2 }, screen: 'climbing', tick: 5 },
      { cone: 0, marker: { deg: 0, r: 1.2 }, screen: 'climbing', tick: 5 },
      { cone: 0, marker: { deg: 0, r: 1.1 }, screen: 'world' },
      { cone: 0, marker: { deg: 0, r: 0.05 }, screen: 'world' },
    ],
    { recover: { climbing: 'attack' }, recoverAfter: 2 },
  );
  const result = await navigate(ctx);
  assert.equal(result.status, 'arrived');
  assert.equal(result.recoveries, 1);
});

test('navigate steers by how the minimap scrolls when the cone is faint', async () => {
  // Faint cone: without `shift` it gives up; with it it runs forward and reads the heading from
  // the scrolled map (east here), then turns the camera 90° left towards the marker in the north.
  const frames = [
    { marker: { deg: 90, r: 1.2 }, ground: [0, 0] },
    { marker: { deg: 90, r: 1.2 }, ground: [6, 0] },
    { marker: { deg: 90, r: 0.3 }, ground: [6, -4] },
  ];
  assert.equal((await navigate(navHarness(frames).ctx)).status, 'no_camera');
  const { ctx, touches } = navHarness(frames, { shift: {}, arriveRadius: 0.35 });
  const result = await navigate(ctx);
  assert.deepEqual([result.status, result.shift, result.drags], ['arrived', 1, 1]);
  const drag = touches.findIndex(([event, x, y]) => event === 'down' && x === 80 && y === 40);
  const up = touches.slice(drag).find(([event]) => event === 'up');
  assert.ok(up[1] < 80 - 200 && up[1] > 80 - 240, `drag ended at ${up[1]}`);
  assert.equal(held(touches), 0);
  // A map that does not scroll is a blocked way: turn each time, then give up as stuck.
  const still = Array.from({ length: 6 }, () => ({ marker: { deg: 90, r: 1.2 }, ground: [0, 0] }));
  const blocked = await navigate(navHarness(still, { shift: {}, stuckLimit: 2 }).ctx);
  assert.deepEqual([blocked.status, blocked.stuck, blocked.drags], ['stuck', 2, 1]);
});

test('navigate stops trusting a cone that does not follow camera turns', async () => {
  // A pale town map: the brightest window stays at 0° however the camera turns. After two such
  // turns the heading comes from the map scroll (north here), so no further turn is needed.
  const frames = [
    { cone: 0, marker: { deg: 90, r: 1.2 } },
    { cone: 0, marker: { deg: 90, r: 1.2 } },
    { cone: 0, marker: { deg: 90, r: 1.2 } },
    { marker: { deg: 90, r: 1.2 }, ground: [0, 0] },
    { marker: { deg: 90, r: 1.2 }, ground: [0, -6] },
    { marker: { deg: 90, r: 0.3 }, ground: [0, -10] },
  ];
  const { ctx } = navHarness(frames, { shift: {}, aimTries: 2, arriveRadius: 0.35 });
  const result = await navigate(ctx);
  assert.deepEqual([result.status, result.coneFrozen, result.shift], ['arrived', true, 1]);
  assert.equal(result.drags, 2);
});

test('navigate stops trusting a cone that jumps to the far side after a turn', async () => {
  // Dusk: a white plaza outshines the cone. After turning to the marker in the north, the cone
  // reads south: no drag lands that far off, so the heading comes from the map scroll at once.
  const frames = [
    { cone: 0, marker: { deg: 90, r: 1.2 } },
    { cone: 250, marker: { deg: 90, r: 1.2 } },
    { marker: { deg: 90, r: 1.2 }, ground: [0, 0] },
    { marker: { deg: 90, r: 1.2 }, ground: [0, -6] },
    { marker: { deg: 90, r: 0.3 }, ground: [0, -10] },
  ];
  const { ctx } = navHarness(frames, { shift: {}, aimTries: 3, arriveRadius: 0.35 });
  const result = await navigate(ctx);
  assert.deepEqual(
    [result.status, result.coneJumped, result.shift, result.drags],
    ['arrived', true, 1, 1],
  );
});

test('navigate on a camera-up minimap turns until the marker is up, without reading a cone', async () => {
  // No cone is drawn: the minimap turns with the camera, so the marker's bearing is the turn.
  const frames = [
    { marker: { deg: 0, r: 1.2 } },
    { marker: { deg: 70, r: 1.2 } },
    { marker: { deg: 90, r: 1.2 } },
    { marker: { deg: 90, r: 0.9 } },
    { marker: { deg: 90, r: 0.05 } },
  ];
  assert.equal((await navigate(navHarness(frames).ctx)).status, 'no_camera');
  const { ctx, touches } = navHarness(frames, { minimapRotates: true, aimTries: 2 });
  const result = await navigate(ctx);
  assert.deepEqual(
    [result.status, result.drags, result.aims, result.shift],
    ['arrived', 2, 1, undefined],
  );
  // The marker east of up: the first drag turns right.
  const drag = touches.findIndex(([event, x, y]) => event === 'down' && x === 80 && y === 40);
  const up = touches.slice(drag).find(([event]) => event === 'up');
  assert.ok(up[1] > 80 + 150, `drag ended at ${up[1]}`);
  assert.equal(held(touches), 0);
});

test('navigate drops from a long climb that does not bring the marker closer', async () => {
  // The view keeps changing (a real climb), but past climbMs the marker is no nearer: a wall.
  const frames = (r) => [
    { cone: 0, marker: { deg: 0, r: 1.2 }, screen: 'climbing' },
    { cone: 0, marker: { deg: 0, r: r[0] }, screen: 'climbing' },
    { cone: 0, marker: { deg: 0, r: r[1] }, screen: 'climbing' },
    { cone: 0, marker: { deg: 0, r: 1.1 }, screen: 'world' },
    { cone: 0, marker: { deg: 0, r: 0.05 }, screen: 'world' },
  ];
  const options = { recover: { climbing: 'attack' }, climbMs: 400, detourMs: 600 };
  const { ctx, touches } = navHarness(frames([1.2, 1.2]), options);
  const result = await navigate(ctx);
  assert.deepEqual([result.status, result.recoveries, result.longClimbs], ['arrived', 1, 1]);
  assert.equal(held(touches), 0);
  // A climb that does bring the marker closer goes on.
  const closer = await navigate(navHarness(frames([1.0, 0.8]), options).ctx);
  assert.deepEqual([closer.status, closer.recoveries], ['arrived', 0]);
  // A quest the HUD says is above (高处): climbing on is the way up, not a wall to drop from.
  const up = navHarness(frames([1.2, 1.2]), options);
  up.ctx.above = true;
  const climbed = await navigate(up.ctx);
  assert.deepEqual([climbed.status, climbed.recoveries], ['arrived', 0]);
});

test('navigate re-reads the cone after a turn and corrects until it faces the marker', async () => {
  // The first drag undershoots (0° → 60° for a 90° error); a second turn closes the gap.
  const { ctx } = navHarness(
    [
      { cone: 0, marker: { deg: 90, r: 1.2 } },
      { cone: 60, marker: { deg: 90, r: 1.2 } },
      { cone: 90, marker: { deg: 90, r: 1.2 } },
      { cone: 90, marker: { deg: 90, r: 0.05 } },
    ],
    { aimTries: 3, aimDeg: 5 },
  );
  const result = await navigate(ctx);
  assert.deepEqual([result.status, result.drags, result.aims], ['arrived', 2, 1]);
});

test('navigate drops off a climb heading well away from the marker and faces it again', async () => {
  const frames = [
    { cone: 0, marker: { deg: 90, r: 1.2 }, screen: 'climbing' },
    { cone: 90, marker: { deg: 90, r: 1.1 }, screen: 'world' },
    { cone: 90, marker: { deg: 90, r: 0.05 }, screen: 'world' },
  ];
  const options = { recover: { climbing: 'attack' }, climbOffDeg: 60 };
  const { ctx, touches } = navHarness(frames, options);
  const result = await navigate(ctx);
  assert.deepEqual([result.status, result.offClimbs, result.drags], ['arrived', 1, 1]);
  const drag = touches.findIndex(([event, x, y]) => event === 'down' && x === 80 && y === 40);
  const up = touches.slice(drag).find(([event]) => event === 'up');
  assert.ok(up[1] < 80 - 200 && up[1] > 80 - 240, `drag ended at ${up[1]}`);
  assert.equal(held(touches), 0);
  // Climbing roughly toward the marker carries on.
  const along = frames.map((f, i) => (i === 0 ? { ...f, cone: 60 } : f));
  const kept = await navigate(navHarness(along, options).ctx);
  assert.equal(kept.offClimbs, undefined);
});

test('navigate steers the joystick by the error left after aiming', async () => {
  const frames = [
    { cone: 0, marker: { deg: 8, r: 1.2 } },
    { cone: 0, marker: { deg: 8, r: 0.05 } },
  ];
  const moves = async (options) => {
    const { ctx, touches } = navHarness(frames, options);
    const result = await navigate(ctx);
    assert.equal(result.status, 'arrived');
    return touches.filter(([event, x]) => event === 'move' && x < 40).map(([, x, y]) => [x, y]);
  };
  // 8° to the left of the heading is under turnDeg, so only the joystick tilts toward it.
  assert.deepEqual((await moves({ steer: true }))[0], [19, 70]);
  assert.deepEqual((await moves({}))[0], [20, 70]);
});

test('navigate with a route steers around a wall on the minimap without turning the camera', async () => {
  const route = {
    bounds: {},
    cells: 21,
    hopMs: 500,
    palette: {
      walk: [
        [60, 60, 60],
        [110, 110, 110],
      ],
      block: [[200, 40, 40]],
    },
  };
  // A wall north of the player, open only to the east; the marker lies beyond it.
  const walled = (frames) => {
    const { ctx, touches } = navHarness(frames, { route, stuckButton: 'jump', stuckLimit: 2 });
    const frame = ctx.frame;
    ctx.rect = () => MAP;
    ctx.frame = async () => {
      const f = await frame();
      for (let y = 34; y < 38; y++)
        for (let x = 18; x < 60; x++) f.image.pixels.set([200, 40, 40], (y * 120 + x) * 3);
      return f;
    };
    return { ctx, touches };
  };
  const { ctx, touches } = walled([
    { cone: 90, marker: { deg: 90, r: 1.2 } },
    { cone: 90, marker: { deg: 90, r: 1.2 } },
    { cone: 90, marker: { deg: 90, r: 0.05 } },
  ]);
  const result = await navigate(ctx);
  assert.deepEqual([result.status, result.drags, result.routes], ['arrived', 0, 2]);
  assert.ok(result.detoured >= 1);
  // The camera faces north, so the stick tilts right (north-east) to go round the wall's end.
  const move = touches.find(([event]) => event === 'move');
  assert.ok(move[1] > 20 && move[2] < 80, `stick at ${move}`);
  // A planned way that does not move the map: jump, avoid it, then give up as stuck.
  const still = Array.from({ length: 5 }, () => ({
    cone: 90,
    marker: { deg: 90, r: 1.2 },
    tick: 1,
  }));
  const blocked = await navigate(walled(still).ctx);
  assert.deepEqual([blocked.status, blocked.stuck, blocked.drags], ['stuck', 2, 0]);
});

test('navigate with a route keeps its planned bearing for holdHops hops while the way is clear', async () => {
  const route = {
    bounds: {},
    cells: 21,
    hopMs: 500,
    palette: {
      walk: [
        [60, 60, 60],
        [110, 110, 110],
      ],
      block: [[200, 40, 40]],
    },
  };
  // The wall shows only on the first frame, as when one frame misreads the minimap.
  const run = async (holdHops) => {
    const { ctx, touches } = navHarness(
      [
        { cone: 90, marker: { deg: 90, r: 1.2 } },
        { cone: 90, marker: { deg: 90, r: 1.2 } },
        { cone: 90, marker: { deg: 90, r: 0.05 } },
      ],
      { route: { ...route, holdHops } },
    );
    const frame = ctx.frame;
    let n = 0;
    ctx.rect = () => MAP;
    ctx.frame = async () => {
      const f = await frame();
      if (n++ === 0)
        for (let y = 34; y < 38; y++)
          for (let x = 18; x < 60; x++) f.image.pixels.set([200, 40, 40], (y * 120 + x) * 3);
      return f;
    };
    const result = await navigate(ctx);
    const moves = touches.filter(([event]) => event === 'move').map(([, x, y]) => [x, y]);
    return { result, moves };
  };
  const replanned = await run(0);
  assert.deepEqual([replanned.result.routes, replanned.result.held], [2, undefined]);
  const kept = await run(3);
  assert.deepEqual([kept.result.status, kept.result.routes, kept.result.held], ['arrived', 1, 1]);
  assert.deepEqual(kept.moves.at(-1), kept.moves[0]);
});

// A 200x100 screen: grey ground, a minimap (0-20, 0-20) whose shade follows `tick`, and red
// rectangles `bars` ({x, y, w, h}, x is the centre).
const FIELD = { width: 200, height: 100 };
const RED = { rgb: [250, 92, 92], tolerance: 20 };
function field({ bars = [], tick = 0 }) {
  const pixels = Buffer.alloc(200 * 100 * 3, 90);
  const paint = (l, t, r, b, rgb) => {
    for (let y = t; y < b; y++) for (let x = l; x < r; x++) pixels.set(rgb, (y * 200 + x) * 3);
  };
  paint(0, 0, 20, 20, [(tick * 37) % 200, 60, 60]);
  for (const bar of bars)
    paint(bar.x - bar.w / 2, bar.y, bar.x + bar.w / 2, bar.y + bar.h, RED.rgb);
  return { width: 200, height: 100, channels: 3, pixels };
}
const FIELD_ENEMY = {
  ...RED,
  bounds: { left: 20, top: 20, right: 200, bottom: 90 },
  minWidth: 10,
  maxHeight: 6,
  nearWidth: 40,
  scale: 1,
};

test('enemyBars keeps thin wide red runs and drops tall or narrow red shapes', () => {
  const image = field({
    bars: [
      { x: 60, y: 30, w: 20, h: 4 },
      { x: 150, y: 50, w: 44, h: 4 },
      { x: 100, y: 60, w: 30, h: 20 }, // a flame: too tall
      { x: 40, y: 80, w: 6, h: 2 }, // a speck: too narrow
      // An off-screen enemy arrow: a wide piece touching a slanted arm.
      { x: 170, y: 22, w: 16, h: 2 },
      ...[0, 1, 2, 3, 4].map((i) => ({ x: 164 + i * 2, y: 24 + i * 2, w: 6, h: 2 })),
    ],
  });
  const bars = enemyBars(image, FIELD_ENEMY.bounds, FIELD, FIELD_ENEMY);
  assert.equal(bars.length, 2);
  assert.ok(Math.abs(bars[0].x - 150) <= 2 && Math.abs(bars[0].y - 51) <= 1);
  assert.ok(Math.abs(bars[1].x - 60) <= 2 && Math.abs(bars[1].y - 31) <= 1);
  assert.ok(bars[0].w >= 42 && bars[0].w <= 46);
});

test('distant enemies are found from OCR-confirmed level labels when no HP bar is visible', async () => {
  const image = field({});
  // "Lv.13"-like text: light grey 1 px strokes on the dark grey ground at (100-130, 40-50).
  for (let x = 100; x < 130; x += 4)
    for (let y = 40; y < 50; y++) image.pixels.set([230, 230, 230], (y * 200 + x) * 3);
  const enemy = { ...FIELD_ENEMY, levelText: '^Lv\\.?\\d' };
  const boxes = [];
  const read = (text) => async (img, box) => (boxes.push(box), text);
  const found = await findEnemies(image, FIELD, enemy, read('Lv.13'));
  assert.equal(found.labels.length, 1);
  assert.ok(Math.abs(found.labels[0].x - 114) <= 4 && found.labels[0].far);
  assert.ok(boxes[0].left <= 100 && boxes[0].right >= 130);
  // OCR reading something else (armour, grass) is not an enemy; without OCR labels are skipped.
  assert.equal((await findEnemies(image, FIELD, enemy, read('D'))).labels.length, 0);
  assert.equal((await findEnemies(image, FIELD, enemy)).labels.length, 0);
  // A visible HP bar wins and OCR is not needed.
  const barred = field({ bars: [{ x: 60, y: 30, w: 20, h: 4 }] });
  boxes.length = 0;
  assert.equal((await findEnemies(barred, FIELD, enemy, read('Lv.13'))).bars.length, 1);
  assert.equal(boxes.length, 0);
});

function approachHarness(frames, routine = {}) {
  const touches = [];
  let clock = 0,
    i = 0;
  const ctx = {
    routine: {
      id: 'approach',
      screens: ['world'],
      viewDegreesPerPixel: 0.5,
      turnDeg: 5,
      ...routine,
    },
    screen: FIELD,
    joystick: { x: 30, y: 80, radius: 10 },
    minimap: { left: 0, top: 0, right: 20, bottom: 20 },
    camera: { x: 150, y: 40, degreesPerPixel: 0.5, deadzone: 0, maxDrag: 100 },
    enemy: FIELD_ENEMY,
    buttonCenter: () => ({ x: 190, y: 90 }),
    frame: async () => {
      clock += 200;
      const f = frames[Math.min(i, frames.length - 1)];
      i++;
      return {
        screen: f.screen ?? 'world',
        image: field({ tick: f.tick ?? i, ...f }),
        damaged: f.damaged,
      };
    },
    touch: async (event, x, y) => touches.push([event, x, y]),
    sleep: async (ms) => (clock += ms),
    now: () => clock,
    random: () => 0,
  };
  return { ctx, touches };
}

test('approach turns towards the nearest enemy bar and walks until it is near', async () => {
  const { ctx, touches } = approachHarness([
    { bars: [{ x: 160, y: 40, w: 20, h: 4 }] },
    { bars: [{ x: 104, y: 40, w: 30, h: 4 }] },
    { bars: [{ x: 100, y: 40, w: 44, h: 4 }] },
  ]);
  const result = await approach(ctx);
  assert.equal(result.status, 'near');
  assert.deepEqual([result.hops, result.drags], [2, 1]);
  // Bar centre about 60 px right of centre at 0.5°/px: turn about 30° clockwise = drag right.
  const drag = touches.findIndex(([event, x, y]) => event === 'down' && x === 150 && y === 40);
  const end = touches.slice(drag).find(([event]) => event === 'up')[1];
  assert.ok(end >= 205 && end <= 212, `drag ended at ${end}`);
  // Hops push the joystick straight up.
  assert.ok(touches.some(([event, x, y]) => event === 'move' && x === 30 && y === 70));
  assert.equal(held(touches), 0);
});

test('approach reports no enemy, a lost enemy and getting stuck', async () => {
  assert.equal((await approach(approachHarness([{}]).ctx)).status, 'no_enemy');
  // Looking around: the bar appears after the second camera turn, without walking first.
  const around = approachHarness([{}, {}, { bars: [{ x: 100, y: 40, w: 44, h: 4 }] }], {
    scanSteps: 5,
    scanDeg: 60,
  });
  const found = await approach(around.ctx);
  assert.deepEqual([found.status, found.scans, found.hops], ['near', 2, 0]);
  const empty = await approach(approachHarness([{}], { scanSteps: 5, scanDeg: 60 }).ctx);
  assert.deepEqual([empty.status, empty.scans, empty.hops], ['no_enemy', 5, 0]);
  assert.equal(held(around.touches), 0);
  // An off-screen arrow to the right of the character: turn right towards it, then find the bar.
  const arrow = [0, 1, 2, 3, 4, 5].map((i) => ({ x: 140 + i * 2, y: 42 + i * 2, w: 6, h: 2 }));
  const turned = approachHarness([{ bars: arrow }, { bars: [{ x: 100, y: 40, w: 44, h: 4 }] }], {
    scanSteps: 5,
  });
  turned.ctx.enemy = { ...FIELD_ENEMY, arrowRing: { inner: 20, outer: 48, minSize: 6 } };
  const faced = await approach(turned.ctx);
  assert.deepEqual([faced.status, faced.arrows, faced.scans], ['near', 1, 0]);
  const up = turned.touches.find(([event]) => event === 'up');
  assert.ok(up[1] > 150, `drag towards the arrow ended at ${up[1]}`);
  const lost = await approach(
    approachHarness([{ bars: [{ x: 100, y: 40, w: 20, h: 4 }] }, {}]).ctx,
  );
  assert.deepEqual([lost.status, lost.hops], ['lost', 3]);
  const stuck = await approach(
    approachHarness([{ bars: [{ x: 100, y: 40, w: 20, h: 4 }], tick: 1 }]).ctx,
  );
  assert.equal(stuck.status, 'stuck');
});

test('hop explore stops when a new enemy bar appears, not for one already visible', async () => {
  const bar = { x: 100, y: 40, w: 20, h: 4 };
  const run = (frames) =>
    explore(approachHarness(frames, { id: 'explore', hopMs: 500, hops: 5, enemyStop: true }).ctx);
  let result = await run([{}, {}, { bars: [bar] }]);
  assert.deepEqual([result.status, result.hops, result.enemies], ['enemy', 2, 1]);
  result = await run([{ bars: [bar] }, { bars: [bar] }, {}, { bars: [bar] }]);
  assert.deepEqual([result.status, result.hops], ['enemy', 3]);
});

test('healthFill reads the HP bar fill and returns null when the bar is hidden', () => {
  const screen = { width: 100, height: 20 };
  const image = (fill, empty = [95, 54, 60]) => {
    const pixels = Buffer.alloc(100 * 20 * 3, 120);
    for (let y = 8; y < 12; y++)
      for (let x = 10; x < 90; x++)
        pixels.set(x < 10 + fill * 80 ? [150, 215, 34] : empty, (y * 100 + x) * 3);
    return { width: 100, height: 20, channels: 3, pixels };
  };
  const bar = {
    bounds: { left: 10, top: 8, right: 90, bottom: 12 },
    rgb: [150, 215, 34],
    tolerance: 40,
  };
  assert.ok(Math.abs(healthFill(image(1), screen, bar) - 1) <= 0.03);
  assert.ok(Math.abs(healthFill(image(0.4), screen, bar) - 0.4) <= 0.03);
  assert.equal(healthFill(image(0), screen, bar), 0);
  // Grey HUD-less frame (a skill animation or menu): unknown, not zero health.
  assert.equal(healthFill(image(0, [120, 120, 120]), screen, bar), null);
});

const HIT = { from: 0.9, to: 0.8 };

test('walking routines with damageStop stop when the active character loses health', async () => {
  const bar = { x: 100, y: 40, w: 20, h: 4 };
  const hop = (frames, extra = {}) =>
    approachHarness(frames, { id: 'explore', hopMs: 500, hops: 5, damageStop: true, ...extra });
  const hit = hop([{}, {}, { damaged: HIT }]);
  const walked = await explore(hit.ctx);
  assert.deepEqual([walked.status, walked.hops, walked.health], ['attacked', 2, HIT]);
  assert.equal(held(hit.touches), 0);
  const ignored = await explore(hop([{}, {}, { damaged: HIT }], { damageStop: false }).ctx);
  assert.notEqual(ignored.status, 'attacked');
  // Approach: hit while the bar is still far → fight here; hit beside a near bar → near.
  const far = await approach(
    approachHarness([{ bars: [bar], damaged: HIT }], { damageStop: true }).ctx,
  );
  assert.deepEqual([far.status, far.hops], ['attacked', 0]);
  const unseen = await approach(approachHarness([{ damaged: HIT }], { damageStop: true }).ctx);
  assert.equal(unseen.status, 'attacked');
  const close = await approach(
    approachHarness([{ bars: [{ ...bar, w: 44 }], damaged: HIT }], { damageStop: true }).ctx,
  );
  assert.equal(close.status, 'near');
  // Navigate stops on the way instead of running on while enemies hit the character.
  const nav = navHarness(
    [
      { cone: 90, marker: { deg: 90, r: 1.2 } },
      { cone: 90, marker: { deg: 90, r: 0.9 }, damaged: HIT },
      { cone: 90, marker: { deg: 90, r: 0.05 } },
    ],
    { damageStop: true },
  );
  const stopped = await navigate(nav.ctx);
  assert.deepEqual([stopped.status, stopped.health], ['attacked', HIT]);
  assert.equal(held(nav.touches), 0);
});

test('combat keeps fighting without enemy bars while health keeps falling', async () => {
  // Each round reads a frame before the switch (odd frames) and one after it (even frames).
  const run = (hits) => {
    let i = 0,
      clock = 0;
    const { ctx } = script([['world', 0]], { ...COMBAT, damageStop: true }, { enemy: ENEMY });
    ctx.frame = async () => {
      clock += 1000;
      const n = i++;
      return {
        screen: 'world',
        image: flat(0, n % 200),
        health: 0.5,
        damaged: hits.includes(n) ? HIT : undefined,
      };
    };
    ctx.now = () => clock;
    return combat(ctx);
  };
  const none = await run([]);
  assert.deepEqual([none.status, none.rounds], ['no_enemy', 1]);
  // Hits on the first two mid-round frames (1 and 3) keep it going; then two quiet rounds clear.
  const hit = await run([1, 3]);
  assert.deepEqual([hit.status, hit.hits, hit.rounds], ['clear', 2, 3]);
  // A drop read right after switching compares two characters and is ignored.
  const switched = await run([2]);
  assert.equal(switched.status, 'no_enemy');
});

const TP_SCREEN = { width: 200, height: 100 };
const QUEST_RGB = [95, 145, 229];
const WAYPOINT_RGB = [50, 152, 216];
// A world-map frame: quest diamonds (6×6 squares), waypoint icons (5×5) with an optional white
// ring of radius 6, and a minimap patch whose shade marks where the player is.
function tpImage({ quests = [], waypoints = [], minimap = 40, tag }) {
  const { width, height } = TP_SCREEN;
  const pixels = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i++) pixels.set([30, 60, 40], i * 3);
  const put = (x, y, rgb) => {
    if (x >= 0 && y >= 0 && x < width && y < height) pixels.set(rgb, (y * width + x) * 3);
  };
  for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) put(x, y, [minimap, minimap, minimap]);
  for (const [qx, qy] of quests)
    for (let y = -3; y < 3; y++) for (let x = -3; x < 3; x++) put(qx + x, qy + y, QUEST_RGB);
  for (const [wx, wy, ring = true] of waypoints) {
    if (ring)
      for (let y = -7; y <= 7; y++)
        for (let x = -7; x <= 7; x++) {
          const r = Math.hypot(x, y);
          if (r >= 5.5 && r <= 6.5) put(wx + x, wy + y, [250, 250, 250]);
        }
    for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) put(wx + x, wy + y, WAYPOINT_RGB);
  }
  return { width, height, channels: 3, pixels, tag };
}

const TELEPORT = {
  id: 'teleport',
  screens: ['world', 'world_map'],
  doneScreens: ['world'],
  open: 'minimap',
  quest: { rgb: QUEST_RGB, tolerance: 10, pixels: [10, 40], size: [4, 8] },
  waypoint: {
    rgb: WAYPOINT_RGB,
    tolerance: 10,
    shapes: [{ pixels: [10, 40], w: [4, 8], h: [4, 8] }],
    ring: { radius: 6, white: 215, min: 4 },
  },
  exclude: [{ x: 15, y: 10, w: 30, h: 20 }],
  title: { x: 170, y: 5, w: 50, h: 10 },
  button: { x: 180, y: 92, w: 30, h: 10 },
  list: { x: 150, y: 60, w: 40, h: 40, rowH: 10 },
  panel: { x: 170, y: 50, w: 60, h: 100 },
  maxMs: 10_000,
};

// Frames follow taps: `step(state, tap)` returns the next state; `texts[tag](box)` is the OCR.
function tpHarness(states, step, texts, routine = {}) {
  const touches = [];
  let clock = 0,
    state = states.start;
  const ctx = {
    routine: { ...TELEPORT, ...routine },
    screen: TP_SCREEN,
    minimap: { left: 0, top: 0, right: 20, bottom: 20 },
    buttonCenter: () => ({ x: 10, y: 10 }),
    rect: (e) => ({
      left: e.x - e.w / 2,
      top: e.y - e.h / 2,
      right: e.x + e.w / 2,
      bottom: e.y + e.h / 2,
    }),
    readText: async (image, box) => texts[image.tag]?.(box) ?? '',
    frame: async () => {
      clock += 100;
      const s = states[state];
      if (s.next) state = s.next;
      return { screen: s.screen, image: tpImage({ ...s, tag: state }) };
    },
    touch: async (event, x, y) => {
      touches.push([event, x, y]);
      if (event === 'up') state = step(state, x, y) ?? state;
    },
    sleep: async (ms) => (clock += ms),
    now: () => clock,
  };
  return {
    ctx,
    touches,
    taps: () => touches.filter(([e]) => e === 'down').map(([, x, y]) => [x, y]),
  };
}

const MAP_STATES = {
  start: 'world',
  world: { screen: 'world', minimap: 40 },
  // Edge indicator at (185,30); the banner diamond at (10,10) is excluded.
  edge: {
    screen: 'world_map',
    quests: [
      [10, 10],
      [185, 30],
    ],
  },
  centred: {
    screen: 'world_map',
    quests: [[100, 50]],
    waypoints: [
      [106, 56, false],
      [130, 70],
      [60, 30],
    ],
  },
  list: { screen: 'world_map', quests: [[100, 50]] },
  panel: { screen: 'world_map', quests: [[100, 50]] },
  loading: { screen: null, next: 'arrived' },
  arrived: { screen: 'world', minimap: 200 },
};
const near = (x, y, px, py) => Math.abs(x - px) <= 2 && Math.abs(y - py) <= 2;
const mapStep = (state, x, y) => {
  if (state === 'world' && near(x, y, 10, 10)) return 'edge';
  if (state === 'edge' && near(x, y, 185, 30)) return 'centred';
  if (state === 'centred' && near(x, y, 130, 70)) return 'list';
  if (state === 'list' && near(x, y, 150, 55)) return 'panel';
  if (state === 'panel' && near(x, y, 180, 92)) return 'loading';
};
const listRow = (box) => (box.top === 50 ? '》传送锚点' : box.top === 60 ? '往事如尘' : '');
const MAP_TEXTS = {
  list: listRow,
  panel: (box) => (box.top === 87 ? '传送' : box.top === 0 ? '传送锚点' : ''),
};

test('mapQuestMarkers and mapWaypoints find tracked quests and unlocked waypoints only', () => {
  const image = tpImage({
    quests: [
      [10, 10],
      [185, 30],
    ],
    waypoints: [
      [60, 30],
      [130, 70, false],
    ],
  });
  const exclude = [{ left: 0, top: 0, right: 30, bottom: 20 }];
  assert.deepEqual(
    mapQuestMarkers(image, TP_SCREEN, TELEPORT.quest, exclude).map((m) => [m.x, m.y]),
    [[185, 30]],
  );
  assert.deepEqual(
    mapWaypoints(image, TP_SCREEN, TELEPORT.waypoint).map((w) => [w.x, w.y]),
    [[60, 30]],
  );
  // A list of specs (e.g. blue world quests and gold Archon quests) matches any of them.
  const gold = { ...TELEPORT.quest, rgb: [233, 180, 13] };
  assert.deepEqual(
    mapQuestMarkers(image, TP_SCREEN, [gold, TELEPORT.quest], exclude).map((m) => [m.x, m.y]),
    [[185, 30]],
  );
});

test('mapQuestMarkers with stack keeps only a tall blob with a partner straight below', () => {
  const image = tpImage({});
  const put = (left, top, w, h) => {
    for (let y = top; y < top + h; y++)
      for (let x = left; x < left + w; x++)
        image.pixels.set([95, 145, 229], (y * image.width + x) * 3);
  };
  // A "!" pin: bar and dot, one above the other; and a lone blob of the same size.
  put(40, 20, 3, 8);
  put(40, 31, 3, 7);
  put(150, 40, 3, 8);
  const spec = { rgb: [95, 145, 229], tolerance: 10, pixels: [15, 30], w: [2, 4], h: [6, 9] };
  assert.equal(mapQuestMarkers(image, TP_SCREEN, spec).length, 3);
  assert.deepEqual(
    mapQuestMarkers(image, TP_SCREEN, { ...spec, stack: [6, 14] }).map((m) => Math.round(m.x)),
    [41],
  );
});

test('mapWaypoints checks the white ring at a shape-specific radius', () => {
  const image = tpImage({});
  const put = (x, y, rgb) => image.pixels.set(rgb, (y * image.width + x) * 3);
  for (let y = -10; y <= 10; y++)
    for (let x = -10; x <= 10; x++) {
      const r = Math.hypot(x, y);
      if (r >= 8.5 && r <= 9.5) put(100 + x, 50 + y, [250, 250, 250]);
      if (r <= 4) put(100 + x, 50 + y, WAYPOINT_RGB);
    }
  const big = { pixels: [40, 60], w: [8, 10], h: [8, 10] };
  const spec = (shape) => ({ ...TELEPORT.waypoint, shapes: [shape] });
  assert.deepEqual(mapWaypoints(image, TP_SCREEN, spec(big)), []);
  assert.deepEqual(
    mapWaypoints(image, TP_SCREEN, spec({ ...big, ringRadius: 9 })).map((w) => [w.x, w.y]),
    [[100, 50]],
  );
});

test('teleport centres the map on the quest and taps 传送 at the nearest waypoint once', async () => {
  const { ctx, taps } = tpHarness(MAP_STATES, mapStep, MAP_TEXTS);
  const result = await teleport(ctx);
  assert.equal(result.status, 'teleported');
  assert.equal(result.target, '传送锚点');
  assert.equal(result.waypoints, 2);
  assert.ok(result.minimapDiff > 30);
  // Minimap, edge indicator, nearest unlocked waypoint (not the locked one), list row, 传送.
  assert.deepEqual(taps(), [
    [10, 10],
    [185, 30],
    [130, 70],
    [150, 55],
    [180, 92],
  ]);
});

test('teleport uses an on-map quest diamond whose tap opens an overlap list in place', async () => {
  const states = {
    ...MAP_STATES,
    edge: { screen: 'world_map', quests: [[40, 70]], waypoints: [[130, 30]] },
    onList: { screen: 'world_map' },
  };
  const step = (state, x, y) =>
    state === 'edge' && near(x, y, 40, 70)
      ? 'onList'
      : state === 'onList' && near(x, y, 150, 55)
        ? 'panel'
        : mapStep(state, x, y);
  const { ctx, taps } = tpHarness(states, step, { ...MAP_TEXTS, onList: listRow });
  const result = await teleport(ctx);
  assert.equal(result.status, 'teleported');
  assert.equal(result.questDistance, 0);
  assert.deepEqual(taps(), [
    [10, 10],
    [40, 70],
    [150, 55],
    [180, 92],
  ]);
});

test('teleport can target a visible unlocked waypoint directly for recovery', async () => {
  const states = {
    ...MAP_STATES,
    edge: { screen: 'world_map', waypoints: [[185, 30]] },
    panel: { screen: 'world_map', waypoints: [[185, 30]] },
  };
  const step = (state, x, y) => {
    if (state === 'world' && near(x, y, 10, 10)) return 'edge';
    if (state === 'edge' && near(x, y, 185, 30)) return 'panel';
    return mapStep(state, x, y);
  };
  const targetWaypoint = TELEPORT.waypoint;
  const { ctx, taps } = tpHarness(states, step, MAP_TEXTS, {
    targetWaypoint,
    targetText: '传送锚点',
  });
  const result = await teleport(ctx);
  assert.equal(result.status, 'teleported');
  assert.deepEqual(taps().slice(0, 3), [
    [10, 10],
    [185, 30],
    [180, 92],
  ]);
});

test('teleport closes the map without teleporting when the quest is near the player', async () => {
  const states = {
    ...MAP_STATES,
    edge: { screen: 'world_map', quests: [[110, 56]], waypoints: [[130, 70]] },
  };
  const { ctx, taps } = tpHarness(states, mapStep, MAP_TEXTS, { nearRadius: 20 });
  let backs = 0;
  ctx.back = async () => {
    backs++;
    states.edge = states.world;
  };
  const result = await teleport(ctx);
  assert.equal(result.status, 'quest_near');
  assert.equal(result.closed, true);
  assert.ok(result.questDistance >= 10 && result.questDistance <= 13);
  assert.equal(backs, 1);
  assert.deepEqual(taps(), [[10, 10]]);

  // A far quest still teleports with nearRadius set.
  const far = tpHarness(MAP_STATES, mapStep, MAP_TEXTS, { nearRadius: 20 });
  far.ctx.back = async () => assert.fail('BACK must not be pressed');
  assert.equal((await teleport(far.ctx)).status, 'teleported');
});

test('teleport reads the HUD quest distance and does not open the map for a close quest', async () => {
  const hud = { distance: { x: 40, y: 80, w: 20, h: 10 }, nearMeters: 150 };
  const texts = (m) => ({ ...MAP_TEXTS, world: (box) => (box.top === 75 ? m : '') });
  const close = tpHarness(MAP_STATES, mapStep, texts('30m'), hud);
  const result = await teleport(close.ctx);
  assert.equal(result.status, 'quest_near');
  assert.equal(result.questMetres, 30);
  assert.equal(close.taps().length, 0);

  for (const m of ['281m', '']) {
    const far = tpHarness(MAP_STATES, mapStep, texts(m), hud);
    assert.equal((await teleport(far.ctx)).status, 'teleported');
  }

  // On a forceScreens screen (e.g. swimming) a close quest is teleported to as well.
  const forced = tpHarness(MAP_STATES, mapStep, texts('30m'), {
    ...hud,
    forceScreens: ['world'],
  });
  assert.equal((await teleport(forced.ctx)).status, 'teleported');
});

test('teleport reports a missing quest or panel without tapping 传送, and never re-taps it', async () => {
  const noQuest = tpHarness({ ...MAP_STATES, edge: { screen: 'world_map' } }, mapStep, MAP_TEXTS);
  assert.equal((await teleport(noQuest.ctx)).status, 'no_quest');

  const noPanel = tpHarness(MAP_STATES, mapStep, { list: () => '' });
  const result = await teleport(noPanel.ctx);
  assert.equal(result.status, 'no_teleport_button');
  assert.equal(result.tried, 2);
  assert.ok(!noPanel.taps().some(([x, y]) => near(x, y, 180, 92)));
  // The second waypoint lies outside the panel and is tried too.
  assert.deepEqual(noPanel.taps().slice(2), [
    [130, 70],
    [60, 30],
  ]);

  const stuck = tpHarness({ ...MAP_STATES, loading: { screen: null } }, mapStep, MAP_TEXTS);
  const timeout = await teleport(stuck.ctx);
  assert.equal(timeout.status, 'timeout');
  assert.equal(stuck.taps().filter(([x, y]) => near(x, y, 180, 92)).length, 1);

  const elsewhere = tpHarness({ ...MAP_STATES, world: { screen: 'dialogue' } }, mapStep, MAP_TEXTS);
  assert.equal((await teleport(elsewhere.ctx)).status, 'interrupted');
  assert.equal(elsewhere.taps().length, 0);
});

test('teleport skips waypoints already tried and taps the next nearest', async () => {
  const step = (state, x, y) =>
    state === 'centred' && near(x, y, 60, 30) ? 'list' : mapStep(state, x, y);
  const { ctx, taps } = tpHarness(MAP_STATES, step, MAP_TEXTS);
  ctx.skip = 1;
  const result = await teleport(ctx);
  assert.equal(result.status, 'teleported');
  assert.equal(result.skipped, 1);
  assert.deepEqual(taps().slice(2, 3), [[60, 30]]);

  // Nothing left past the skipped ones.
  const none = tpHarness(MAP_STATES, mapStep, MAP_TEXTS);
  none.ctx.skip = 2;
  assert.equal((await teleport(none.ctx)).status, 'no_waypoint');
});

test('teleport re-taps a waypoint whose first tap only closed the quest overlap list', async () => {
  const states = {
    ...MAP_STATES,
    edge: { screen: 'world_map', quests: [[40, 70]], waypoints: [[130, 30]] },
    onList: { screen: 'world_map', waypoints: [[130, 30]] },
  };
  const step = (state, x, y) => {
    if (state === 'edge' && near(x, y, 40, 70)) return 'onList';
    if (state === 'onList' && near(x, y, 130, 30)) return 'edge';
    if (state === 'edge' && near(x, y, 130, 30)) return 'list';
    return mapStep(state, x, y);
  };
  const { ctx, taps } = tpHarness(states, step, { ...MAP_TEXTS, onList: () => '' });
  const result = await teleport(ctx);
  assert.equal(result.status, 'teleported');
  assert.equal(result.reopened, true);
  assert.deepEqual(taps(), [
    [10, 10],
    [40, 70],
    [130, 30],
    [130, 30],
    [150, 55],
    [180, 92],
  ]);
});

test('teleport zooms a zoomed-out map in until the quest diamond can be seen', async () => {
  // The map opens zoomed out ('small': no diamond matches); two zoom taps reveal the edge one.
  const states = {
    ...MAP_STATES,
    small: { screen: 'world_map' },
    small2: { screen: 'world_map' },
  };
  const step = (state, x, y) => {
    if (state === 'world' && near(x, y, 10, 10)) return 'small';
    if (state === 'small' && near(x, y, 5, 90)) return 'small2';
    if (state === 'small2' && near(x, y, 5, 90)) return 'edge';
    return mapStep(state, x, y);
  };
  const zoomed = tpHarness(states, step, MAP_TEXTS, { zoomIn: 'zoom', zoomTaps: 3 });
  zoomed.ctx.buttonCenter = (id) => (id === 'zoom' ? { x: 5, y: 90 } : { x: 10, y: 10 });
  const result = await teleport(zoomed.ctx);
  assert.equal(result.status, 'teleported');
  assert.equal(result.zooms, 2);
  assert.deepEqual(zoomed.taps().slice(0, 4), [
    [10, 10],
    [5, 90],
    [5, 90],
    [185, 30],
  ]);

  // Zooming stops after zoomTaps and reports no_quest.
  const never = tpHarness(states, (s) => (s === 'world' ? 'small' : s), MAP_TEXTS, {
    zoomIn: 'zoom',
    zoomTaps: 2,
  });
  never.ctx.buttonCenter = (id) => (id === 'zoom' ? { x: 5, y: 90 } : { x: 10, y: 10 });
  const none = await teleport(never.ctx);
  assert.equal(none.status, 'no_quest');
  assert.equal(none.zooms, 2);
});

const TRACK = {
  id: 'track_quest',
  screens: ['world'],
  doneScreens: ['world'],
  open: 'quest',
  hud: { x: 20, y: 40, w: 20, h: 10, match: '^\\d+\\s*m$' },
  title: { x: 20, y: 5, w: 20, h: 10 },
  name: { x: 100, y: 10, w: 60, h: 10 },
  button: { x: 180, y: 90, w: 30, h: 10 },
};

// States: world (untracked) → log → world (tracked). `texts[state][box.top]` is the OCR.
function trackHarness(states, texts, step) {
  const touches = [];
  let clock = 0,
    backs = 0,
    state = states.start;
  const ctx = {
    routine: TRACK,
    screen: TP_SCREEN,
    buttonCenter: () => ({ x: 10, y: 10 }),
    rect: (e) => ({
      left: e.x - e.w / 2,
      top: e.y - e.h / 2,
      right: e.x + e.w / 2,
      bottom: e.y + e.h / 2,
    }),
    readText: async (image, box) => texts[image.tag]?.[box.top] ?? '',
    frame: async () => ({ screen: states[state], image: { width: 200, height: 100, tag: state } }),
    touch: async (event, x, y) => {
      touches.push([event, x, y]);
      if (event === 'up') state = step(state, x, y) ?? state;
    },
    back: async () => {
      backs++;
      state = 'world';
    },
    sleep: async (ms) => (clock += ms),
    now: () => clock,
  };
  return { ctx, taps: () => touches.filter(([e]) => e === 'down').length, backs: () => backs };
}
const TRACK_STATES = { start: 'untracked', untracked: 'world', log: 'menu', world: 'world' };
const trackStep = (state, x, y) =>
  state === 'untracked' && x === 10 && y === 10
    ? 'log'
    : state === 'log' && x === 180 && y === 90
      ? 'world'
      : undefined;

test('trackQuest taps 追踪目标 once and verifies the HUD quest distance', async () => {
  const texts = {
    log: { 0: '进行中', 5: '无意义的等待的意义', 85: '追踪目标' },
    world: { 35: '28m' },
  };
  const h = trackHarness(TRACK_STATES, texts, trackStep);
  const result = await trackQuest(h.ctx);
  assert.equal(result.status, 'tracked');
  assert.equal(result.quest, '无意义的等待的意义');
  assert.equal(result.distance, '28m');
  assert.equal(h.taps(), 2);
});

test('trackQuest does nothing when a quest is tracked and closes a log that says 停止追踪', async () => {
  const shown = trackHarness(
    { ...TRACK_STATES, start: 'world' },
    { world: { 35: '9m' } },
    trackStep,
  );
  assert.equal((await trackQuest(shown.ctx)).status, 'already_tracked');
  assert.equal(shown.taps(), 0);

  const texts = { log: { 0: '进行中', 5: '善后工作', 85: '停止追踪' } };
  const log = trackHarness(TRACK_STATES, texts, trackStep);
  const result = await trackQuest(log.ctx);
  assert.equal(result.status, 'already_tracked');
  assert.equal(result.closed, true);
  assert.equal(log.taps(), 1);
  assert.equal(log.backs(), 1);

  const other = trackHarness(TRACK_STATES, { log: { 0: '背包' } }, trackStep);
  assert.equal((await trackQuest(other.ctx)).status, 'no_quest_log');
});

test('trackQuest closes the big map a far quest opens, once, and verifies the HUD', async () => {
  const texts = {
    log: { 0: '进行中', 5: '无意义的等待的意义', 85: '追踪目标' },
    world: { 35: '257m' },
  };
  const step = (state, x, y) =>
    state === 'log' && x === 180 && y === 90 ? 'map' : trackStep(state, x, y);
  const h = trackHarness({ ...TRACK_STATES, map: 'world_map' }, texts, step);
  h.ctx.routine = { ...TRACK, mapScreens: ['world_map'] };
  const result = await trackQuest(h.ctx);
  assert.equal(result.status, 'tracked');
  assert.equal(result.viaMap, true);
  assert.equal(result.distance, '257m');
  assert.equal(h.taps(), 2);
  assert.equal(h.backs(), 1);
});

test('trackQuest re-tracks a quest in another region and leaves its map open', async () => {
  // log (停止追踪) → untracked log (追踪目标) → map on the quest. The HUD still shows a distance,
  // but a teleport found no quest on the map (`force`), so it is in another region.
  const texts = {
    untracked: { 35: '6277m' },
    log: { 0: '进行中', 5: '骑士团手册问答', 85: '停止追踪' },
    log2: { 0: '进行中', 85: '追踪目标' },
  };
  const step = (state, x, y) =>
    state === 'log' && x === 180 && y === 90
      ? 'log2'
      : state === 'log2' && x === 180 && y === 90
        ? 'map'
        : trackStep(state, x, y);
  const states = { ...TRACK_STATES, log2: 'menu', map: 'world_map' };
  const h = trackHarness(states, texts, step);
  h.ctx.routine = { ...TRACK, mapScreens: ['world_map'], keepMap: true, retrack: true };
  h.ctx.force = true;
  const result = await trackQuest(h.ctx);
  assert.deepEqual(
    [result.status, result.screen, result.retracked, result.quest],
    ['tracked_far', 'world_map', 1, '骑士团手册问答'],
  );
  assert.equal(h.taps(), 3);
  assert.equal(h.backs(), 0);
});

test('teleport tracks the quest again so the game centres the map on it, else opens the map', async () => {
  // The map button centres the map on the player, where another quest's marker can be mistaken
  // for the tracked one. 停止追踪 then 追踪 makes the game open the map on the tracked quest.
  const states = {
    ...MAP_STATES,
    log: { screen: 'menu' },
    log2: { screen: 'menu' },
    back: { screen: 'world', minimap: 40 },
  };
  const texts = {
    ...MAP_TEXTS,
    world: (box) => (box.top === 35 ? '935m' : ''),
    log: (box) => ({ 0: '进行中', 5: '客从远方来', 85: '停止追踪' })[box.top] ?? '',
    log2: (box) => ({ 0: '进行中', 85: '追踪' })[box.top] ?? '',
  };
  const track = { ...TRACK, mapScreens: ['world_map'], keepMap: true, retrack: true };
  const run = async (tracked) => {
    const step = (state, x, y) =>
      state === 'world' && near(x, y, 10, 10)
        ? 'log'
        : state === 'log' && near(x, y, 180, 90)
          ? 'log2'
          : state === 'log2' && near(x, y, 180, 90)
            ? tracked
            : state === 'back' && near(x, y, 10, 10)
              ? 'edge'
              : mapStep(state, x, y);
    const h = tpHarness(states, step, texts);
    h.ctx.track = track;
    return { result: await teleport(h.ctx), taps: h.taps() };
  };

  const far = await run('centred');
  assert.deepEqual([far.result.status, far.result.tracked], ['teleported', 'tracked_far']);
  // Quest log, 停止追踪, 追踪 (the map opens on the quest), waypoint, list row, 传送: no minimap.
  assert.deepEqual(far.taps, [
    [10, 10],
    [180, 90],
    [180, 90],
    [130, 70],
    [150, 55],
    [180, 92],
  ]);

  // The game returned to the world instead: open the map with the map button as before.
  const back = await run('back');
  assert.equal(back.result.status, 'teleported');
  assert.deepEqual(back.taps.slice(3, 5), [
    [10, 10],
    [185, 30],
  ]);
});

test('teleport zooms the tracked map in fully, then out until a teleport point is near', async () => {
  // Fully zoomed in, the only visible point is farther than the screen edge: one nearer may lie
  // off screen, so zoom out one step (the quest stays centred) and pick from the wider view.
  const states = {
    ...MAP_STATES,
    log: { screen: 'menu' },
    log2: { screen: 'menu' },
    zoomedIn: { screen: 'world_map', quests: [[100, 50]], waypoints: [[180, 90]] },
  };
  const texts = {
    ...MAP_TEXTS,
    world: (box) => (box.top === 35 ? '935m' : ''),
    log: (box) => ({ 0: '进行中', 5: '客从远方来', 85: '停止追踪' })[box.top] ?? '',
    log2: (box) => ({ 0: '进行中', 85: '追踪' })[box.top] ?? '',
  };
  const step = (state, x, y) =>
    state === 'world' && near(x, y, 10, 10)
      ? 'log'
      : state === 'log' && near(x, y, 180, 90)
        ? 'log2'
        : state === 'log2' && near(x, y, 180, 90)
          ? 'zoomedIn'
          : state === 'zoomedIn' && near(x, y, 20, 90)
            ? 'centred'
            : mapStep(state, x, y);
  const h = tpHarness(states, step, texts, {
    maxZoom: 'zin',
    maxZoomTaps: 2,
    zoomOut: 'zout',
    zoomOutTaps: 3,
  });
  h.ctx.track = { ...TRACK, mapScreens: ['world_map'], keepMap: true, retrack: true };
  h.ctx.buttonCenter = (id) =>
    id === 'zin' ? { x: 20, y: 80 } : id === 'zout' ? { x: 20, y: 90 } : { x: 10, y: 10 };
  const result = await teleport(h.ctx);
  assert.deepEqual([result.status, result.maxZoom, result.zoomOuts], ['teleported', 2, 1]);
  assert.deepEqual(h.taps().slice(3), [
    [20, 80],
    [20, 80],
    [20, 90],
    [130, 70],
    [150, 55],
    [180, 92],
  ]);
});

test('hudDistance reads the HUD quest distance 0m that OCR returns as om', () => {
  assert.deepEqual(['om', 'Om', 'o m', '1om', '257m', '', '已到达任务区域'].map(hudDistance), [
    '0m',
    '0m',
    '0 m',
    '10m',
    '257m',
    '',
    '0m',
  ]);
});
