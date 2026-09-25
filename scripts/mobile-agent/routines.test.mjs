import { test } from 'node:test';
import assert from 'node:assert/strict';
import { combat, dialogue, explore, regionMotion } from './routines.mjs';

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

function script(frames, routine) {
  const touches = [];
  let clock = 0,
    i = 0;
  const ctx = {
    routine,
    screen: SCREEN,
    enemyBounds: { left: 0, top: 0, right: 40, bottom: 10 },
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

test('combat with an enemy colour stops when no enemy is left', async () => {
  const enemy = { rgb: [200, 200, 200], tolerance: 10, minPixels: 1 };
  const frames = [
    ['world', 200],
    ['world', 200],
    ['world', 0],
    ['world', 0],
  ];
  const cleared = await combat(script(frames, { ...COMBAT, enemy }).ctx);
  assert.equal(cleared.status, 'clear');
  assert.equal(cleared.rounds, 3);
  assert.ok(cleared.enemy[0] > 0 && cleared.enemy.at(-1) === 0);
  const none = await combat(script([['world', 0]], { ...COMBAT, enemy }).ctx);
  assert.deepEqual([none.status, none.rounds], ['no_enemy', 0]);
});
