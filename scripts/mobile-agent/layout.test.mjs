import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { AdbDevice } from './adb-device.mjs';
import { candidatesFor } from './actions.mjs';
import { buildQuestions, TypeSafePolicy } from './policy.mjs';
import { createDevice } from './create-device.mjs';
import {
  annotateScreenshot,
  detectScreen,
  hudScale,
  layoutRoutines,
  loadLayout,
  resolveRect,
  validateLayout,
  withLayout,
} from './layout.mjs';
import { decodePng, encodePng, rgbAt } from './png.mjs';
import { ROUTINES } from './routines.mjs';
import { lazyRecognizer } from './ocr.mjs';
import { runAgent } from './agent.mjs';

const GAME = 'com.miHoYo.GenshinImpact';

function image(width, height, fill = [10, 20, 30], patches = []) {
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const patch = patches.find((p) => x >= p.left && x < p.right && y >= p.top && y < p.bottom);
      pixels.set([...(patch?.rgb ?? fill), 255], (y * width + x) * 4);
    }
  return encodePng({ width, height, pixels });
}

const layout = validateLayout({
  name: 'Test game',
  appLabel: 'Test Game',
  packageNames: [GAME],
  reference: { width: 200, height: 100 },
  screens: {
    world: { description: 'World HUD', probes: [{ x: 10, y: 10, rgb: [250, 0, 0] }] },
    menu: {
      description: 'Menu',
      probes: [{ x: 190, y: 10, anchor: 'top-right', rgb: [0, 0, 250] }],
    },
  },
  buttons: [
    {
      id: 'attack',
      label: 'Attack',
      anchor: 'bottom-right',
      x: 180,
      y: 80,
      w: 20,
      h: 20,
      screens: ['world'],
    },
    {
      id: 'close',
      label: 'Close',
      anchor: 'top-right',
      x: 190,
      y: 10,
      w: 10,
      h: 10,
      screens: ['menu'],
    },
    { id: 'menu', label: 'Menu', x: 10, y: 10, w: 10, h: 10 },
  ],
});

test('PNG round-trips through the screencap decoder', () => {
  const decoded = decodePng(
    image(4, 3, [1, 2, 3], [{ left: 1, top: 1, right: 2, bottom: 2, rgb: [9, 8, 7] }]),
  );
  assert.equal(decoded.width, 4);
  assert.deepEqual(rgbAt(decoded, 0, 0), [1, 2, 3]);
  assert.deepEqual(rgbAt(decoded, 1, 1), [9, 8, 7]);
  assert.throws(() => decodePng(Buffer.from('nope')), /not a PNG/);
});

test('anchored buttons keep their edge distance on wider screens', () => {
  // 250x100 is wider than the 200x100 reference: scale stays 1, right-anchored controls shift.
  assert.deepEqual(resolveRect(layout.buttons[0], { width: 250, height: 100 }, layout.reference), {
    left: 220,
    top: 70,
    right: 240,
    bottom: 90,
  });
  // Doubling the resolution doubles offsets and sizes.
  assert.deepEqual(resolveRect(layout.buttons[2], { width: 400, height: 200 }, layout.reference), {
    left: 10,
    top: 10,
    right: 30,
    bottom: 30,
  });
});

test('uiAspect keeps the HUD scale on narrower phones and scales tablets by width', () => {
  const reference = { width: 2400, height: 1080, uiAspect: 16 / 9 };
  const attack = { id: 'a', label: 'A', anchor: 'bottom-right', x: 1920, y: 830, w: 100, h: 100 };
  const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual}`);
  near(hudScale({ width: 2376, height: 1080 }, reference), 1);
  near(hudScale({ width: 1920, height: 1080 }, reference), 1);
  near(hudScale({ width: 2560, height: 1600 }, reference), 2560 / 1920);
  // Without uiAspect the reference ratio applies (the previous behaviour).
  assert.equal(hudScale({ width: 1920, height: 1080 }, { width: 2400, height: 1080 }), 0.8);
  assert.deepEqual(resolveRect(attack, { width: 2376, height: 1080 }, reference), {
    left: 1846,
    top: 780,
    right: 1946,
    bottom: 880,
  });
  const base = { name: 'x', packageNames: [GAME], buttons: [] };
  assert.throws(
    () => validateLayout({ ...base, reference: { width: 16, height: 9, uiAspect: 3 } }),
    /uiAspect/,
  );
  assert.throws(
    () => validateLayout({ ...base, reference: { width: 16, height: 9, uiAspect: 0 } }),
    /uiAspect/,
  );
});

test('layout validation rejects unknown screens and duplicate ids', () => {
  const base = { name: 'x', packageNames: [GAME], reference: { width: 10, height: 10 } };
  assert.throws(
    () =>
      validateLayout({
        ...base,
        buttons: [{ id: 'a', label: 'A', x: 1, y: 1, w: 1, h: 1, screens: ['nope'] }],
      }),
    /unknown screen/,
  );
  assert.throws(
    () =>
      validateLayout({
        ...base,
        buttons: [
          { id: 'a', label: 'A', x: 1, y: 1, w: 1, h: 1 },
          { id: 'a', label: 'B', x: 1, y: 1, w: 1, h: 1 },
        ],
      }),
    /unique/,
  );
  const routine = { id: 'walk', type: 'explore', label: 'Walk', screens: ['world'] };
  const withRoutine = (extra) => () =>
    validateLayout({ ...layout, joystick: { x: 30, y: 70, radius: 10 }, ...extra });
  assert.throws(withRoutine({ routines: [routine] }), /needs layout joystick and minimap/);
  const minimap = { x: 60, y: 50, w: 20, h: 20 };
  assert.throws(withRoutine({ minimap, routines: [{ ...routine, type: 'fly' }] }), /type/);
  assert.throws(
    withRoutine({ minimap, routines: [{ ...routine, recover: { world: 'nope' } }] }),
    /unknown button/,
  );
  assert.throws(
    withRoutine({ minimap, routines: [{ ...routine, stopScreens: ['nope'] }] }),
    /unknown screen/,
  );
  const go = { ...routine, id: 'go', type: 'navigate', marker: { rgb: [250, 230, 0] } };
  assert.throws(withRoutine({ minimap, routines: [go] }), /needs a layout camera/);
  const camera = { x: 50, y: 40, degreesPerPixel: 0.5, maxDrag: 30 };
  assert.throws(withRoutine({ minimap, camera, routines: [go] }), /recognise the marker colour/);
  withRoutine({
    minimap,
    camera,
    routines: [{ ...go, marker: { ...go.marker, tolerance: 40 } }],
  })();
  // Dialogue and combat drive buttons, so they need neither joystick nor minimap.
  const talk = { id: 'talk', type: 'dialogue', label: 'Talk', screens: ['menu'] };
  assert.throws(() => validateLayout({ ...layout, routines: [talk] }), /button is required/);
  validateLayout({ ...layout, routines: [{ ...talk, button: 'close', doneScreens: ['world'] }] });
  const fight = { id: 'fight', type: 'combat', label: 'Fight', screens: ['world'] };
  assert.throws(() => validateLayout({ ...layout, routines: [fight] }), /attack is required/);
  assert.throws(
    () =>
      validateLayout({
        ...layout,
        routines: [{ ...fight, attack: 'attack', switchButtons: ['nope'] }],
      }),
    /unknown button/,
  );
  const enemy = { x: 100, y: 50, w: 100, h: 50, rgb: [255, 0], tolerance: 20 };
  assert.throws(() => validateLayout({ ...layout, enemy }), /enemy.rgb/);
  const fighting = validateLayout({
    ...layout,
    enemy: { ...enemy, rgb: [255, 0, 0] },
    routines: [{ ...fight, attack: 'attack' }],
  });
  assert.deepEqual(layoutRoutines(fighting, { width: 200, height: 100 }, 'world')[0].bounds, {
    left: 170,
    top: 70,
    right: 190,
    bottom: 90,
  });
  // Approaching an enemy needs a camera and a layout enemy with a fighting distance.
  const near = { id: 'near', type: 'approach', label: 'Near', screens: ['world'] };
  const approachLayout = { minimap, camera, routines: [{ ...near, viewDegreesPerPixel: 0.04 }] };
  assert.throws(withRoutine(approachLayout), /needs a layout enemy with nearWidth/);
  withRoutine({ ...approachLayout, enemy: { ...enemy, rgb: [255, 0, 0], nearWidth: 50 } })();
  assert.throws(
    withRoutine({ minimap, routines: [{ ...routine, hopMs: 500, enemyStop: true }] }),
    /enemyStop needs a layout enemy/,
  );
});

test('probes identify the current screen', () => {
  const screen = { width: 200, height: 100 };
  const world = decodePng(
    image(200, 100, [0, 0, 0], [{ left: 5, top: 5, right: 15, bottom: 15, rgb: [240, 10, 10] }]),
  );
  assert.equal(detectScreen(world, screen, layout).screen, 'world');
  // Half-resolution screenshots are sampled proportionally.
  const small = decodePng(
    image(100, 50, [0, 0, 0], [{ left: 90, top: 0, right: 100, bottom: 10, rgb: [0, 0, 255] }]),
  );
  assert.equal(detectScreen(small, screen, layout).screen, 'menu');
  assert.equal(detectScreen(decodePng(image(200, 100)), screen, layout).screen, null);
});

test('drift probes find a floating panel at a shared horizontal offset', () => {
  const screen = { width: 200, height: 100 };
  const panel = validateLayout({
    ...layout,
    screens: {
      prompt: {
        drift: { x: 6 },
        probes: [
          { x: 10, y: 10, rgb: [250, 0, 0] },
          { x: 100, y: 50, anchor: 'center', rgb: [200, 200, 200], drift: true },
          { x: 104, y: 50, anchor: 'center', rgb: [0, 200, 0], drift: true },
        ],
      },
    },
    buttons: [{ id: 'ok', label: 'OK', x: 10, y: 10, w: 4, h: 4 }],
  });
  const hud = { left: 5, top: 5, right: 15, bottom: 15, rgb: [240, 10, 10] };
  // A 1 px rim followed by the panel body, shifted 4 px left of the calibrated place.
  const shifted = (dx) =>
    decodePng(
      image(
        200,
        100,
        [0, 0, 0],
        [
          hud,
          { left: 100 + dx, top: 45, right: 101 + dx, bottom: 55, rgb: [200, 200, 200] },
          { left: 101 + dx, top: 45, right: 110 + dx, bottom: 55, rgb: [0, 200, 0] },
        ],
      ),
    );
  const found = detectScreen(shifted(-4), screen, panel);
  assert.equal(found.screen, 'prompt');
  assert.equal(found.results.prompt.offset, -4);
  assert.equal(detectScreen(shifted(0), screen, panel).results.prompt.offset, 0);
  // Beyond drift.x, or with only the rim, the panel is not detected.
  assert.equal(detectScreen(shifted(-9), screen, panel).screen, null);
  const rimOnly = decodePng(
    image(
      200,
      100,
      [0, 0, 0],
      [hud, { left: 96, top: 45, right: 97, bottom: 55, rgb: [200, 200, 200] }],
    ),
  );
  assert.equal(detectScreen(rimOnly, screen, panel).screen, null);
  assert.throws(
    () => validateLayout({ ...panel, screens: { prompt: { drift: { x: -1 }, probes: [] } } }),
    /drift\.x/,
  );
});

function fakeGame({ foreground = GAME, png, profile = layout, recognizer }) {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    if (args[2] === 'get-state') return Buffer.from('device\n');
    const script = args[3] ?? '';
    if (script.includes('dumpsys window'))
      return Buffer.from(
        `  mCurrentFocus=Window{1 u0 ${foreground}/com.miHoYo.GetMobileInfo.MainActivity}\n`,
      );
    if (script.includes('screencap')) return png();
    if (script.includes('getprop')) return Buffer.from('Test phone\n');
    if (script.includes('query-activities'))
      return Buffer.from(`packageName=${GAME}\npackageName=com.android.settings\n`);
    if (script.includes('uiautomator')) throw new Error('uiautomator must not run in the game');
    return Buffer.alloc(0);
  };
  return {
    calls,
    device: withLayout(new AdbDevice({ run, deviceId: 'SERIAL1' }), profile, { recognizer }),
  };
}

test('game screens expose only the fixed controls for the detected screen', async () => {
  let png = image(
    200,
    100,
    [0, 0, 0],
    [{ left: 5, top: 5, right: 15, bottom: 15, rgb: [250, 0, 0] }],
  );
  const { device, calls } = fakeGame({ png: () => png });
  const observation = await device.observe();
  assert.equal(observation.phone.packageName, GAME);
  assert.deepEqual(
    { ...observation.layout, signature: undefined },
    {
      profile: 'Test game',
      screen: 'world',
      description: 'World HUD',
      signature: undefined,
    },
  );
  assert.match(observation.layout.signature, /^[0-9a-f]{64}$/);
  const taps = Object.keys(candidatesFor(observation)).filter((id) => id.startsWith('tap_'));
  assert.deepEqual(taps.sort(), ['tap_layout.attack', 'tap_layout.menu']);
  const { tap } = buildQuestions(observation);
  assert.ok(Object.values(tap).some((entry) => entry.action.elementId === 'layout.attack'));
  assert.match(observation.elements.find((e) => e.id === 'layout-screen').text, /World HUD/);

  await device.act({ type: 'tap-element', elementId: 'layout.attack' }, { expected: observation });
  assert.equal(calls.at(-1)[3], 'input tap 180 80');

  // A button with holdMs is pressed in place instead of tapped.
  const held = fakeGame({
    png: () => png,
    profile: validateLayout({
      ...layout,
      buttons: layout.buttons.map((b) => (b.id === 'attack' ? { ...b, holdMs: 300 } : b)),
    }),
  });
  await held.device.act(
    { type: 'tap-element', elementId: 'layout.attack' },
    { expected: await held.device.observe() },
  );
  assert.equal(held.calls.at(-1)[3], 'input swipe 180 80 180 80 300');
  assert.equal((await held.device.observe()).layout.previousAction.control, '"Attack"');
  assert.throws(
    () => validateLayout({ ...layout, buttons: [{ ...layout.buttons[0], holdMs: 0 }] }),
    /holdMs/,
  );

  // A different detected screen invalidates the old decision before any input.
  png = image(
    200,
    100,
    [0, 0, 0],
    [{ left: 185, top: 5, right: 195, bottom: 15, rgb: [0, 0, 250] }],
  );
  const inputs = calls.length;
  await assert.rejects(
    device.act({ type: 'tap-element', elementId: 'layout.attack' }, { expected: observation }),
    /Screen changed/,
  );
  assert.ok(calls.slice(inputs).every((args) => !String(args[3]).startsWith('input')));
});

test('routines are offered with raw touch input and run as one bounded action', async () => {
  const profile = validateLayout({
    ...layout,
    joystick: { anchor: 'bottom-left', x: 30, y: 70, radius: 10 },
    minimap: { x: 60, y: 50, w: 20, h: 20 },
    routines: [
      {
        id: 'explore',
        type: 'explore',
        label: 'Explore',
        description: 'Walk around.',
        screens: ['world'],
        stopScreens: ['menu'],
        maxMs: 5000,
      },
    ],
  });
  const world = (fill) =>
    image(
      200,
      100,
      [fill, fill, fill],
      [{ left: 5, top: 5, right: 15, bottom: 15, rgb: [250, 0, 0] }],
    );
  const menu = image(
    200,
    100,
    [0, 0, 0],
    [{ left: 185, top: 5, right: 195, bottom: 15, rgb: [0, 0, 250] }],
  );
  const frames = [world(0), world(0), world(0), world(60), menu];
  let shot = 0;
  const { device, calls } = fakeGame({
    profile,
    png: () => frames[Math.min(shot++, frames.length - 1)],
  });
  device.random = () => 0;
  const observation = await device.observe();
  const routine = observation.elements.find((e) => e.id === 'layout-routine.explore');
  assert.equal(routine.label, 'Explore: Walk around.');
  assert.ok(candidatesFor(observation)['tap_layout-routine.explore']);
  const receipt = await device.act(
    { type: 'tap-element', elementId: 'layout-routine.explore' },
    { expected: observation },
  );
  assert.equal(receipt.routine.status, 'found');
  assert.equal(receipt.routine.screen, 'menu');
  const inputs = calls.map((args) => args[3]).filter((s) => String(s).startsWith('input'));
  assert.deepEqual(inputs, [
    'input motionevent DOWN 30 70',
    'input motionevent MOVE 40 70',
    'input motionevent UP 40 70',
  ]);
  const after = await device.observe();
  assert.equal(after.layout.previousAction.routine.status, 'found');

  device.touch = undefined;
  shot = 0;
  const plain = await device.observe();
  assert.ok(!plain.elements.some((e) => e.id.startsWith('layout-routine.')));
});

test('a falling HP bar stops a damageStop routine and the next observation reports the threat', async () => {
  const profile = validateLayout({
    ...layout,
    joystick: { anchor: 'bottom-left', x: 30, y: 70, radius: 10 },
    minimap: { x: 60, y: 50, w: 20, h: 20 },
    healthBar: { x: 100, y: 90, w: 80, h: 4, rgb: [150, 215, 34], screens: ['world'] },
    routines: [
      {
        id: 'explore',
        type: 'explore',
        label: 'Explore',
        description: 'Walk around.',
        screens: ['world'],
        hopMs: 300,
        hops: 5,
        damageStop: true,
        maxMs: 20000,
      },
    ],
  });
  const world = (fill, hp) =>
    image(
      200,
      100,
      [fill, fill, fill],
      [
        { left: 5, top: 5, right: 15, bottom: 15, rgb: [250, 0, 0] },
        { left: 60, top: 88, right: 60 + hp * 80, bottom: 92, rgb: [150, 215, 34] },
        { left: 60 + hp * 80, top: 88, right: 140, bottom: 92, rgb: [95, 54, 60] },
      ],
    );
  const frames = [world(0, 1), world(0, 1), world(30, 1), world(60, 1), world(90, 0.6)];
  let shot = 0;
  const { device } = fakeGame({
    profile,
    png: () => frames[Math.min(shot++, frames.length - 1)],
  });
  device.random = () => 0;
  const seen = { frames: [], events: [] };
  device.debug = {
    frame: ({ source, screen, health, damaged }) =>
      seen.frames.push({ source, screen, health, damaged }),
    event: (event) => seen.events.push(event),
  };
  const observation = await device.observe();
  assert.equal(observation.layout.threat, undefined);
  const receipt = await device.act(
    { type: 'tap-element', elementId: 'layout-routine.explore' },
    { expected: observation },
  );
  assert.equal(receipt.routine.status, 'attacked');
  assert.deepEqual(receipt.routine.health, { from: 1, to: 0.6 });
  // Debug viewers get every frame (observe and routine) and the routine's start, touches and end.
  assert.equal(seen.frames[0].source, 'observe');
  assert.deepEqual(seen.frames.at(-1), {
    source: 'explore',
    screen: 'world',
    health: 0.6,
    damaged: { from: 1, to: 0.6 },
  });
  assert.deepEqual(seen.events[0], { type: 'routine_start', routine: 'explore', kind: 'explore' });
  assert.ok(seen.events.some((e) => e.type === 'touch' && e.target === 'joystick'));
  assert.deepEqual(
    { type: seen.events.at(-1).type, status: seen.events.at(-1).status },
    { type: 'routine_end', status: 'attacked' },
  );
  const after = await device.observe();
  assert.equal(after.layout.threat, 'attacked');
  assert.match(after.layout.description, /health falling \(100% → 60%\).*Fight back now/);
  assert.throws(
    () => validateLayout({ ...profile, healthBar: { ...profile.healthBar, rgb: [1, 2] } }),
    /healthBar\.rgb/,
  );
  assert.throws(
    () => validateLayout({ ...profile, healthBar: { ...profile.healthBar, screens: ['map'] } }),
    /unknown screen map/,
  );
});

test('unrecognized game screens offer no fixed control; other apps use the UI tree', async () => {
  const { device } = fakeGame({ png: () => image(200, 100) });
  const observation = await device.observe();
  assert.equal(observation.layout.screen, 'unknown');
  assert.equal(observation.elements.filter((e) => e.id.startsWith('layout.')).length, 0);
  assert.match(
    observation.elements.find((e) => e.id === 'layout-screen').text,
    /no fixed control is offered/,
  );
  // Without probes the screen cannot be identified, so every control stays available.
  const blind = fakeGame({
    png: () => image(200, 100),
    profile: validateLayout({ ...layout, screens: {}, buttons: [layout.buttons[2]] }),
  });
  const blindObservation = await blind.device.observe();
  assert.equal(blindObservation.elements.filter((e) => e.id.startsWith('layout.')).length, 1);
  assert.deepEqual(await device.listApps(), [
    { packageName: 'com.android.settings', label: 'settings' },
    { packageName: GAME, label: 'Test Game' },
  ]);

  const other = fakeGame({ foreground: 'com.android.settings', png: () => image(200, 100) });
  await assert.rejects(other.device.observe(), /uiautomator must not run/);
});

async function captureRequest(observation) {
  let body;
  const policy = new TypeSafePolicy({
    apiKey: 'test',
    request: async (request) => {
      body = request.body;
      throw new Error('captured');
    },
  });
  await assert.rejects(policy.decide({ goal: 'Attack', observation }), /captured/);
  return body;
}

test('traces record the effect of the previous executed action, but Jev does not see it', async () => {
  const world = image(
    200,
    100,
    [0, 0, 0],
    [{ left: 5, top: 5, right: 15, bottom: 15, rgb: [250, 0, 0] }],
  );
  const menu = image(
    200,
    100,
    [0, 0, 0],
    [{ left: 185, top: 5, right: 195, bottom: 15, rgb: [0, 0, 250] }],
  );
  let png = world;
  const { device } = fakeGame({ png: () => png });
  const first = await device.observe();
  assert.equal(first.layout.previousAction, undefined);

  await device.act({ type: 'tap-element', elementId: 'layout.attack' }, { expected: first });
  const same = await device.observe();
  assert.deepEqual(same.layout.previousAction, {
    control: '"Attack"',
    before: 'world',
    after: 'world',
  });
  assert.deepEqual(
    same.elements.map((e) => e.id),
    first.elements.map((e) => e.id),
  );
  const request = await captureRequest(same);
  assert.equal(JSON.stringify(request).includes('previousAction'), false);
  assert.equal(JSON.stringify(request).includes('"world"'), true);

  await device.act({ type: 'global', name: 'back' }, { expected: same });
  png = menu;
  const changed = await device.observe();
  assert.deepEqual(changed.layout.previousAction, {
    control: 'system BACK',
    before: 'world',
    after: 'menu',
  });

  // A stale rejection happens before input, so the recorded effect is kept as it was.
  await assert.rejects(
    device.act({ type: 'tap-element', elementId: 'layout.attack' }, { expected: same }),
    /Screen changed/,
  );
  assert.equal((await device.observe()).layout.previousAction.control, 'system BACK');
});

test('declared text regions of the detected screen are read into elements Jev sees', async () => {
  const profile = validateLayout({
    ...layout,
    statusTexts: [
      {
        id: 'health',
        label: 'Health',
        x: 100,
        y: 90,
        w: 50,
        h: 10,
        match: '^\\d+/\\d+$',
        screens: ['world'],
      },
    ],
    screens: {
      ...layout.screens,
      world: {
        ...layout.screens.world,
        texts: [
          {
            id: 'toast',
            label: 'Notice',
            x: 50,
            y: 20,
            w: 60,
            h: 10,
            fix: { '^0b': 'Ob' },
            match: '^Obtained',
          },
          {
            id: 'detail',
            label: 'Detail',
            x: 50,
            y: 40,
            w: 60,
            h: 10,
            requires: 'toast',
            remember: true,
          },
        ],
      },
    },
    buttons: layout.buttons.map((b) =>
      b.id === 'attack' ? { ...b, text: { x: 150, y: 80, w: 30, h: 10 } } : b,
    ),
  });
  const world = image(
    200,
    100,
    [0, 0, 0],
    [{ left: 5, top: 5, right: 15, bottom: 15, rgb: [250, 0, 0] }],
  );
  let png = world;
  const boxes = [];
  let label = 'Pick up lotus';
  let notice = 'Obtained x1';
  let detail = 'Lotus';
  let health = '200/1000';
  const recognizer = {
    recognize: async (_image, box) => {
      boxes.push(box);
      const text = box.left > 100 ? label : box.top > 80 ? health : box.top < 30 ? notice : detail;
      return { text, confidence: 0.9 };
    },
  };
  const { device } = fakeGame({ png: () => png, profile, recognizer });
  const observation = await device.observe();
  // Screen coordinates map onto the 200x100 screenshot; bottom-right anchor keeps the offset.
  assert.deepEqual(boxes, [
    { left: 135, top: 75, right: 165, bottom: 85 },
    { left: 20, top: 15, right: 80, bottom: 25 },
    { left: 20, top: 35, right: 80, bottom: 45 },
    { left: 75, top: 85, right: 125, bottom: 95 },
  ]);
  assert.equal(observation.elements.find((e) => e.id === 'layout.attack').text, 'Pick up lotus');
  const toast = observation.elements.find((e) => e.id === 'layout-text.toast');
  assert.deepEqual([toast.text, toast.label, toast.clickable], ['Obtained x1', 'Notice', false]);
  assert.equal(observation.elements.find((e) => e.id === 'layout-text.detail').text, 'Lotus');
  assert.equal(observation.elements.find((e) => e.id === 'layout-text.health').text, '200/1000');
  assert.equal(observation.layout.ocr.regions, 4);
  const request = JSON.stringify(await captureRequest(observation));
  assert.ok(request.includes('Pick up lotus') && request.includes('Obtained x1'));

  // Background noise fails `match`, and the region that requires it is dropped as well.
  notice = '号';
  health = 'unknown';
  const noisy = await device.observe();
  assert.deepEqual(
    noisy.elements.filter((e) => e.id.startsWith('layout-text.')),
    [],
  );
  // `fix` repairs a known OCR confusion before `match` runs.
  notice = '0btained x1';
  health = '200/1000';
  assert.equal(
    (await device.observe()).elements.find((e) => e.id === 'layout-text.toast').text,
    'Obtained x1',
  );
  notice = 'Obtained x1';

  // A `remember` region states its last code-read change, even after it was hidden in between;
  // punctuation-only OCR differences are not a change.
  assert.ok(!(await device.observe()).layout.description.includes('last changed'));
  detail = 'Lotus，';
  assert.ok(!(await device.observe()).layout.description.includes('last changed'));
  // A few characters dropped by OCR are not a change either.
  detail = 'Lotu';
  assert.ok(!(await device.observe()).layout.description.includes('last changed'));
  notice = '号';
  await device.observe();
  notice = 'Obtained x1';
  detail = 'Lily';
  const changed = 'Code read that Detail last changed from "Lotus" to "Lily".';
  assert.ok((await device.observe()).layout.description.includes(changed));
  assert.ok((await device.observe()).layout.description.includes(changed));
  detail = 'Lotus';

  // OCR punctuation and spacing noise alone does not make the decision stale.
  label = 'Pick up，lotus」';
  await device.act({ type: 'tap-element', elementId: 'layout.attack' }, { expected: observation });

  // A changed caption on the target makes the decision stale before any input.
  label = 'Open chest';
  await assert.rejects(
    device.act({ type: 'tap-element', elementId: 'layout.attack' }, { expected: observation }),
    /Screen changed/,
  );

  // Unrecognized screens read nothing; an unavailable engine reports it and reads nothing.
  boxes.length = 0;
  png = image(200, 100);
  assert.equal((await device.observe()).layout.ocr, undefined);
  assert.equal(boxes.length, 0);
  png = world;
  const off = fakeGame({ png: () => png, profile, recognizer: lazyRecognizer(async () => null) });
  const plain = await off.device.observe();
  assert.deepEqual(plain.layout.ocr, { unavailable: true });
  assert.equal(plain.elements.find((e) => e.id === 'layout.attack').text, '');
  assert.throws(
    () =>
      validateLayout({
        ...profile,
        buttons: [{ ...profile.buttons[0], text: { x: 1, y: 1, w: 0, h: 5 } }],
      }),
    /text\.w/,
  );
  assert.throws(
    () =>
      validateLayout({
        ...profile,
        screens: {
          ...profile.screens,
          world: { ...profile.screens.world, texts: [{ ...profile.screens.world.texts[1] }] },
        },
      }),
    /requires unknown region/,
  );
  assert.throws(
    () =>
      validateLayout({
        ...profile,
        screens: {
          ...profile.screens,
          world: {
            ...profile.screens.world,
            texts: [{ ...profile.screens.world.texts[0], match: '(' }],
          },
        },
      }),
    /match must be a regular expression/,
  );
  assert.throws(
    () =>
      validateLayout({
        ...profile,
        screens: {
          ...profile.screens,
          world: {
            ...profile.screens.world,
            texts: [{ ...profile.screens.world.texts[0], fix: { '[': 'x' } }],
          },
        },
      }),
    /fix keys must be regular expressions/,
  );
});

function layoutRun(signatures, actions, receipt = {}) {
  let frame = 0;
  const observed = [];
  const device = {
    layout: { settleMs: 0 },
    assertReady: async () => {},
    observe: async () => {
      const i = frame++;
      return {
        deviceId: 'd',
        phone: { packageName: GAME },
        screen: { width: 200, height: 100 },
        elements: [],
        fingerprint: `pixels-${i}`,
        layout: { screen: 'world', signature: signatures[Math.min(i, signatures.length - 1)] },
      };
    },
    act: async () => receipt,
  };
  let n = 0;
  const policy = {
    decide: async () => ({
      status: 'action',
      action: { type: 'tap-element', elementId: actions[n++ % actions.length] },
    }),
  };
  return runAgent({
    device,
    policy,
    goal: 'Pick up',
    execute: true,
    maxSteps: 6,
    settleTimeoutMs: 0,
    onObservation: (event) => observed.push(event),
  }).then((result) => ({ result, observed }));
}

test('a navigate that does not shrink the quest distance is reported and lets teleport force', async () => {
  const profile = validateLayout({
    ...layout,
    screens: {
      ...layout.screens,
      world: {
        ...layout.screens.world,
        texts: [{ id: 'dist', label: 'Quest distance', x: 50, y: 40, w: 60, h: 10, match: 'm$' }],
      },
    },
    joystick: { anchor: 'bottom-left', x: 30, y: 70, radius: 10 },
    minimap: { x: 60, y: 50, w: 20, h: 20 },
    camera: { x: 120, y: 50, degreesPerPixel: 0.5, maxDrag: 40 },
    routines: [
      {
        id: 'navigate',
        type: 'navigate',
        label: 'Navigate',
        screens: ['world'],
        marker: { rgb: [250, 230, 0], tolerance: 40 },
        progressText: 'dist',
        progressMetres: 5,
      },
      {
        id: 'teleport',
        type: 'teleport',
        label: 'Teleport',
        screens: ['world'],
        open: 'menu',
        doneScreens: ['world'],
        quest: { rgb: [90, 140, 230], tolerance: 30, pixels: [5, 50], size: [2, 9] },
        waypoint: {
          rgb: [50, 150, 210],
          tolerance: 30,
          shapes: [{ pixels: [5, 50], w: [2, 9], h: [2, 9] }],
          ring: { radius: 4, white: 215, min: 4 },
        },
        title: { x: 100, y: 10, w: 40, h: 10 },
        button: { x: 100, y: 90, w: 40, h: 10 },
      },
    ],
  });
  const world = image(
    200,
    100,
    [0, 0, 0],
    [{ left: 5, top: 5, right: 15, bottom: 15, rgb: [250, 0, 0] }],
  );
  let distance = '89m';
  const recognizer = { recognize: async () => ({ text: distance, confidence: 0.9 }) };
  const { device } = fakeGame({ png: () => world, profile, recognizer });
  device.touch = async () => {};
  const original = { navigate: ROUTINES.navigate, teleport: ROUTINES.teleport };
  const seen = [];
  let status = 'timeout';
  ROUTINES.navigate = async () => ({ routine: 'navigate', status });
  ROUTINES.teleport = async (ctx) => {
    seen.push(ctx.force);
    return { routine: 'teleport', status: 'teleported' };
  };
  const walk = async () =>
    device.act(
      { type: 'tap-element', elementId: 'layout-routine.navigate' },
      { expected: await device.observe() },
    );
  const blocked = 'made no progress (89m → 87m)';
  try {
    assert.equal((await walk()).routine.fromMetres, 89);
    distance = '87m';
    const after = await device.observe();
    assert.ok(after.layout.description.includes(blocked));
    assert.deepEqual(after.layout.blocked, { from: 89, to: 87, count: 1 });
    // The finding persists until teleport runs, which is then told to skip its near checks.
    assert.ok((await device.observe()).layout.description.includes(blocked));
    await device.act(
      { type: 'tap-element', elementId: 'layout-routine.teleport' },
      { expected: await device.observe() },
    );
    assert.ok(!(await device.observe()).layout.description.includes('no progress'));
    await device.act(
      { type: 'tap-element', elementId: 'layout-routine.teleport' },
      { expected: await device.observe() },
    );
    assert.deepEqual(seen, [true, undefined]);
    // Real progress, or arriving, is not reported as blocked.
    await walk();
    distance = '70m';
    assert.equal((await device.observe()).layout.blocked, undefined);
    status = 'arrived';
    await walk();
    assert.equal((await device.observe()).layout.blocked, undefined);
  } finally {
    Object.assign(ROUTINES, original);
  }
});

test('a teleport that finds no quest withholds teleport until track_quest runs', async () => {
  const profile = validateLayout({
    ...layout,
    joystick: { anchor: 'bottom-left', x: 30, y: 70, radius: 10 },
    minimap: { x: 60, y: 50, w: 20, h: 20 },
    camera: { x: 120, y: 50, degreesPerPixel: 0.5, maxDrag: 40 },
    routines: [
      {
        id: 'navigate',
        type: 'navigate',
        label: 'Navigate',
        screens: ['world'],
        marker: { rgb: [250, 230, 0], tolerance: 40 },
      },
      {
        id: 'teleport',
        type: 'teleport',
        label: 'Teleport',
        screens: ['world'],
        open: 'menu',
        doneScreens: ['world'],
        quest: { rgb: [90, 140, 230], tolerance: 30, pixels: [5, 50], size: [2, 9] },
        waypoint: {
          rgb: [50, 150, 210],
          tolerance: 30,
          shapes: [{ pixels: [5, 50], w: [2, 9], h: [2, 9] }],
          ring: { radius: 4, white: 215, min: 4 },
        },
        title: { x: 100, y: 10, w: 40, h: 10 },
        button: { x: 100, y: 90, w: 40, h: 10 },
      },
      {
        id: 'track_quest',
        type: 'track_quest',
        label: 'Track quest',
        screens: ['world'],
        open: 'menu',
        doneScreens: ['world'],
        hud: { x: 50, y: 40, w: 60, h: 10 },
        title: { x: 100, y: 10, w: 40, h: 10 },
        button: { x: 100, y: 90, w: 40, h: 10 },
      },
    ],
  });
  const world = image(
    200,
    100,
    [0, 0, 0],
    [{ left: 5, top: 5, right: 15, bottom: 15, rgb: [250, 0, 0] }],
  );
  const { device } = fakeGame({ png: () => world, profile });
  device.touch = async () => {};
  const original = {
    teleport: ROUTINES.teleport,
    track_quest: ROUTINES.track_quest,
    navigate: ROUTINES.navigate,
  };
  const forced = [];
  ROUTINES.teleport = async () => ({ routine: 'teleport', status: 'no_quest' });
  ROUTINES.track_quest = async (ctx) => {
    forced.push(ctx.force);
    return { routine: 'track_quest', status: 'tracked_far' };
  };
  ROUTINES.navigate = async () => ({ routine: 'navigate', status: 'no_marker' });
  const offered = (o) =>
    o.elements.map((e) => e.id).filter((id) => id.startsWith('layout-routine'));
  const run = async (id) =>
    device.act(
      { type: 'tap-element', elementId: `layout-routine.${id}` },
      { expected: await device.observe() },
    );
  try {
    await run('teleport');
    // Still the teleport's own result: the full sentence, teleport still offered.
    assert.ok(offered(await device.observe()).includes('layout-routine.teleport'));
    await device.act({ type: 'global', name: 'back' }, { expected: await device.observe() });
    const after = await device.observe();
    assert.ok(after.layout.farQuest);
    assert.ok(after.layout.description.includes('Use Track quest now'));
    assert.ok(!offered(after).includes('layout-routine.teleport'));
    assert.ok(offered(after).includes('layout-routine.track_quest'));
    // Another routine in between keeps teleport withheld.
    await run('navigate');
    assert.ok((await device.observe()).layout.farQuest);
    await run('track_quest');
    const tracked = await device.observe();
    assert.equal(tracked.layout.farQuest, undefined);
    assert.ok(offered(tracked).includes('layout-routine.teleport'));
    await run('track_quest');
    // Forced only while teleport had found no quest: it re-tracks despite a HUD distance.
    assert.deepEqual(forced, [true, undefined]);
  } finally {
    Object.assign(ROUTINES, original);
  }
});

test('a blocked navigate sidesteps left then right before suggesting teleport', async () => {
  const profile = validateLayout({
    ...layout,
    screens: {
      ...layout.screens,
      world: {
        ...layout.screens.world,
        texts: [{ id: 'dist', label: 'Quest distance', x: 50, y: 40, w: 60, h: 10, match: 'm$' }],
      },
    },
    joystick: { anchor: 'bottom-left', x: 30, y: 70, radius: 10 },
    minimap: { x: 60, y: 50, w: 20, h: 20 },
    camera: { x: 120, y: 50, degreesPerPixel: 0.5, maxDrag: 40 },
    routines: [
      {
        id: 'navigate',
        type: 'navigate',
        label: 'Navigate',
        screens: ['world'],
        marker: { rgb: [250, 230, 0], tolerance: 40 },
        progressText: 'dist',
        progressMetres: 5,
        sidestepMs: 1000,
        sidestepTries: 2,
      },
    ],
  });
  const world = image(
    200,
    100,
    [0, 0, 0],
    [{ left: 5, top: 5, right: 15, bottom: 15, rgb: [250, 0, 0] }],
  );
  const recognizer = { recognize: async () => ({ text: '30m', confidence: 0.9 }) };
  const { device } = fakeGame({ png: () => world, profile, recognizer });
  device.touch = async () => {};
  const original = ROUTINES.navigate;
  const sides = [];
  ROUTINES.navigate = async (ctx) => {
    sides.push(ctx.sidestep);
    return { routine: 'navigate', status: 'timeout' };
  };
  try {
    const descriptions = [];
    for (let i = 0; i < 4; i++) {
      await device.act(
        { type: 'tap-element', elementId: 'layout-routine.navigate' },
        { expected: await device.observe() },
      );
      // Observing twice does not count the same walk twice.
      await device.observe();
      descriptions.push((await device.observe()).layout.description);
    }
    assert.deepEqual(sides, [undefined, 'left', 'right', undefined]);
    assert.match(descriptions[0], /walks to the left/);
    assert.match(descriptions[1], /walks to the right/);
    assert.match(descriptions[2], /teleport instead/);
  } finally {
    ROUTINES.navigate = original;
  }
});

test('a blocked navigate still escalates when the quest distance becomes unreadable', async () => {
  const profile = validateLayout({
    ...layout,
    screens: {
      ...layout.screens,
      world: {
        ...layout.screens.world,
        texts: [{ id: 'dist', label: 'Quest distance', x: 50, y: 40, w: 60, h: 10, match: 'm$' }],
      },
    },
    joystick: { anchor: 'bottom-left', x: 30, y: 70, radius: 10 },
    minimap: { x: 60, y: 50, w: 20, h: 20 },
    camera: { x: 120, y: 50, degreesPerPixel: 0.5, maxDrag: 40 },
    routines: [
      {
        id: 'navigate',
        type: 'navigate',
        label: 'Navigate',
        screens: ['world'],
        marker: { rgb: [250, 230, 0], tolerance: 40 },
        progressText: 'dist',
        progressMetres: 5,
        sidestepMs: 1000,
        sidestepTries: 2,
      },
    ],
  });
  const world = image(
    200,
    100,
    [0, 0, 0],
    [{ left: 5, top: 5, right: 15, bottom: 15, rgb: [250, 0, 0] }],
  );
  let text = '30m';
  const recognizer = { recognize: async () => ({ text, confidence: 0.9 }) };
  const { device } = fakeGame({ png: () => world, profile, recognizer });
  device.touch = async () => {};
  const original = ROUTINES.navigate;
  const sides = [];
  ROUTINES.navigate = async (ctx) => {
    sides.push(ctx.sidestep);
    return { routine: 'navigate', status: 'timeout' };
  };
  try {
    const descriptions = [];
    for (let i = 0; i < 4; i++) {
      await device.act(
        { type: 'tap-element', elementId: 'layout-routine.navigate' },
        { expected: await device.observe() },
      );
      await device.observe();
      descriptions.push((await device.observe()).layout.description);
      text = '';
    }
    assert.deepEqual(sides, [undefined, 'left', 'right', undefined]);
    assert.match(descriptions[2], /teleport instead/);
  } finally {
    ROUTINES.navigate = original;
  }
});

test('a blocked walk withholds navigate and retries teleport at the next nearest points', async () => {
  const profile = validateLayout({
    ...layout,
    screens: {
      ...layout.screens,
      world: {
        ...layout.screens.world,
        texts: [{ id: 'dist', label: 'Quest distance', x: 50, y: 40, w: 60, h: 10, match: 'm$' }],
      },
    },
    joystick: { anchor: 'bottom-left', x: 30, y: 70, radius: 10 },
    minimap: { x: 60, y: 50, w: 20, h: 20 },
    camera: { x: 120, y: 50, degreesPerPixel: 0.5, maxDrag: 40 },
    routines: [
      {
        id: 'navigate',
        type: 'navigate',
        label: 'Navigate',
        screens: ['world'],
        marker: { rgb: [250, 230, 0], tolerance: 40 },
        progressText: 'dist',
        progressMetres: 5,
        sidestepMs: 1000,
        sidestepTries: 1,
      },
      {
        id: 'teleport',
        type: 'teleport',
        label: 'Teleport',
        screens: ['world'],
        open: 'menu',
        doneScreens: ['world'],
        quest: { rgb: [90, 140, 230], tolerance: 30, pixels: [5, 50], size: [2, 9] },
        waypoint: {
          rgb: [50, 150, 210],
          tolerance: 30,
          shapes: [{ pixels: [5, 50], w: [2, 9], h: [2, 9] }],
          ring: { radius: 4, white: 215, min: 4 },
        },
        title: { x: 100, y: 10, w: 40, h: 10 },
        button: { x: 100, y: 90, w: 40, h: 10 },
      },
    ],
  });
  const world = image(
    200,
    100,
    [0, 0, 0],
    [{ left: 5, top: 5, right: 15, bottom: 15, rgb: [250, 0, 0] }],
  );
  // The quest distance is unreadable throughout (as while climbing): failed walks still count.
  const recognizer = { recognize: async () => ({ text: '', confidence: 0.9 }) };
  const { device } = fakeGame({ png: () => world, profile, recognizer });
  device.touch = async () => {};
  const originals = { navigate: ROUTINES.navigate, teleport: ROUTINES.teleport };
  const skips = [];
  const tpStatus = ['no_teleport_button', 'teleported'];
  ROUTINES.navigate = async () => ({ routine: 'navigate', status: 'timeout' });
  ROUTINES.teleport = async (ctx) => {
    skips.push([ctx.skip, ctx.force]);
    const status = tpStatus.shift();
    return { routine: 'teleport', status, ...(status === 'teleported' ? {} : { tried: 2 }) };
  };
  const ids = (o) => o.elements.map((e) => e.id).filter((id) => id.startsWith('layout-routine'));
  const use = async (id) =>
    device.act({ type: 'tap-element', elementId: id }, { expected: await device.observe() });
  try {
    await use('layout-routine.navigate');
    await use('layout-routine.navigate');
    let o = await device.observe();
    assert.ok(!ids(o).includes('layout-routine.navigate'));
    assert.ok(ids(o).includes('layout-routine.teleport'));
    assert.match(o.layout.description, /Navigate is unavailable/);
    assert.match(o.layout.description, /unreadable → unreadable/);

    await use('layout-routine.teleport');
    o = await device.observe();
    assert.equal(o.layout.blocked.skip, 2);
    assert.match(o.layout.description, /code tries the next nearest teleport point/);
    assert.ok(!ids(o).includes('layout-routine.navigate'));

    await use('layout-routine.teleport');
    o = await device.observe();
    assert.equal(o.layout.blocked, undefined);
    assert.ok(ids(o).includes('layout-routine.navigate'));
    assert.deepEqual(skips, [
      [undefined, true],
      [2, true],
    ]);
  } finally {
    Object.assign(ROUTINES, originals);
  }
});

test('the same game control used twice without a visible change stops the run', async () => {
  // Pixels differ every frame, so only the layout signature can show that nothing happened.
  const { result, observed } = await layoutRun(['a', 'b'], ['layout.sprint']);
  assert.equal(result.status, 'no_progress');
  assert.equal(result.steps, 3);
  assert.match(result.decision.reason, /twice in a row/);
  assert.deepEqual(
    observed.map((e) => e.initial ?? false),
    [true, false, false, false],
  );
  // Alternating controls, or a changing screen, keep going until the step limit.
  assert.equal(
    (await layoutRun(['a'], ['layout.sprint', 'layout.jump'])).result.status,
    'step_limit',
  );
  assert.equal(
    (await layoutRun(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], ['layout.attack'])).result.status,
    'step_limit',
  );
  // A routine that moved the character is progress even when the screen reads the same.
  const walk = 'layout-routine.explore';
  assert.equal(
    (await layoutRun(['a'], [walk], { routine: { status: 'walked', moved: true } })).result.status,
    'step_limit',
  );
  assert.equal(
    (await layoutRun(['a'], [walk], { routine: { status: 'stuck', moved: false } })).result.status,
    'no_progress',
  );
});

test('unknown frames are re-captured up to unknownRetries times', async () => {
  const world = image(
    200,
    100,
    [0, 0, 0],
    [{ left: 5, top: 5, right: 15, bottom: 15, rgb: [250, 0, 0] }],
  );
  const frames = [image(200, 100), image(200, 100), world];
  const retrying = fakeGame({
    png: () => frames.shift() ?? world,
    profile: validateLayout({ ...layout, unknownRetries: 2 }),
  });
  assert.equal((await retrying.device.observe()).layout.screen, 'world');

  const blank = fakeGame({
    png: () => image(200, 100),
    profile: validateLayout({ ...layout, unknownRetries: 1 }),
  });
  assert.equal((await blank.device.observe()).layout.screen, 'unknown');
  assert.equal(blank.calls.filter((args) => String(args[3]).includes('screencap')).length, 2);
  assert.throws(() => validateLayout({ ...layout, unknownRetries: 9 }), /unknownRetries/);
});

test('shipped Genshin profile is valid and annotates a screenshot', () => {
  const path = fileURLToPath(new URL('../../layouts/genshin-impact.json', import.meta.url));
  const genshin = loadLayout(path);
  assert.ok(genshin.packageNames.includes('com.miHoYo.Yuanshen'));
  const report = annotateScreenshot(image(240, 108), genshin, { width: 2400, height: 1080 });
  assert.equal(report.buttons.length, genshin.buttons.length);
  assert.equal(decodePng(report.png).width, 240);
  assert.equal(
    createDevice({ backend: 'adb', layout: 'layouts/genshin-impact.json' }).layout.name,
    genshin.name,
  );
});
