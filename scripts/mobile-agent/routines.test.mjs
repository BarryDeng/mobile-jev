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

const MAP = { left: 10, top: 10, right: 90, bottom: 90 };
const MAP_SCREEN = { width: 120, height: 100 };
const YELLOW = { rgb: [251, 232, 2], tolerance: 30 };
// A minimap with a brighter 85° view cone at `cone` degrees, an optional yellow marker and
// corners whose shade changes with `tick` so consecutive frames differ like a moving map.
// `ground` [x, y] draws textured terrain seen from that position, so the map scrolls with it.
function mapImage({ cone, marker, ring, diamond, ground, tick = 0 }) {
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
        if (Math.hypot(x - mx, y - my) <= 3) rgb = [251, 232, 2];
      }
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
      return { screen: f.screen ?? 'world', image: mapImage({ ...f, tick: f.tick ?? i }) };
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
      return { screen: f.screen ?? 'world', image: field({ tick: f.tick ?? i, ...f }) };
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
