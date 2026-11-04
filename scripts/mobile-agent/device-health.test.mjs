import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHealth, withHealthGuard } from './device-health.mjs';

const DUMP = (thermal, level, ac = true) =>
  `Thermal Status: ${thermal}\nCurrent Battery Service state:\n  AC powered: ${ac}\n  USB powered: false\n  level: ${level}\n  temperature: 429\n`;

test('parseHealth reads thermal status, battery level, power and temperature', () => {
  assert.deepEqual(parseHealth(DUMP(3, 80)), {
    thermal: 3,
    battery: 80,
    powered: true,
    temperatureC: 42.9,
  });
  assert.equal(parseHealth(DUMP(0, 15, false)).powered, false);
});

function fakeDevice(readings) {
  let clock = 0;
  const calls = [];
  const device = {
    health: async () => parseHealth(readings.shift() ?? DUMP(0, 80)),
    setScreen: async (on) => calls.push(on ? 'wake' : 'sleep'),
    frame: async () => {
      clock += device.frameMs;
      return {};
    },
    observe: async () => {
      calls.push('observe');
      return {};
    },
    act: async () => {
      // Like a layout routine, the action observes again for freshness first.
      await device.observe();
    },
    frameMs: 500,
  };
  const options = {
    sleep: async (ms) => {
      clock += ms;
      calls.push(`sleep ${ms}`);
    },
    now: () => clock,
  };
  return { device, calls, options, events: [] };
}

test('the guard rests a throttled phone with the screen off until it cools', async () => {
  const { device, calls, options, events } = fakeDevice([DUMP(3, 80), DUMP(2, 80), DUMP(1, 80)]);
  withHealthGuard(device, {
    ...options,
    screenOff: true,
    pollMs: 1000,
    wakeMs: 5000,
    onEvent: (e) => events.push(e.event),
  });
  await device.observe();
  assert.deepEqual(calls, ['sleep', 'sleep 1000', 'sleep 1000', 'wake', 'sleep 5000', 'observe']);
  assert.deepEqual(events, ['health', 'rest', 'rest', 'resumed']);
  // Within checkMs and with fast frames, the next observe does not check again.
  calls.length = 0;
  await device.observe();
  assert.deepEqual(calls, ['observe']);
});

test('slow captures trigger an early check, and an uncharged low battery stops the run', async () => {
  const { device, options, events } = fakeDevice([DUMP(0, 80), DUMP(0, 10, false)]);
  withHealthGuard(device, { ...options, onEvent: (e) => events.push(e) });
  await device.observe();
  device.frameMs = 3000;
  for (let i = 0; i < 3; i++) await device.frame();
  await assert.rejects(device.observe(), /battery is 10% and not charging/);
  assert.equal(events.at(-1).frameMs, 3000);
});

test('the guard does not rest inside an action', async () => {
  const { device, calls, options } = fakeDevice([DUMP(0, 80), DUMP(3, 80)]);
  withHealthGuard(device, { ...options, checkMs: 0, pollMs: 1000 });
  await device.observe();
  calls.length = 0;
  // checkMs has elapsed, but the action's own observe skips the check.
  await device.act();
  assert.deepEqual(calls, ['observe']);
  // The next observe between steps checks and rests.
  await device.observe();
  assert.ok(calls.includes('sleep 1000'));
});

test('devices without health readings are returned unchanged', () => {
  const device = { observe: async () => ({}) };
  const observe = device.observe;
  assert.equal(withHealthGuard(device).observe, observe);
});
