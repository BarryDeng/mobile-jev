import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  continuousGoal,
  continuousRecovery,
  healthRatio,
  runContinuousAgent,
} from './continuous.mjs';

const element = (id, text = '') => ({ id, text, clickable: true });
const observation = (screen, elements = [], n = 0) => ({
  deviceId: 'phone',
  phone: { packageName: 'game' },
  screen: { width: 200, height: 100 },
  elements,
  fingerprint: `frame-${n}`,
  layout: { screen, signature: `layout-${n}` },
});

test('continuous recovery revives, heals low health and rotates useful world activities', () => {
  assert.equal(
    continuousRecovery(observation('defeated', [element('layout.revive_defeated')])).choice,
    'layout.revive_defeated',
  );
  const low = observation('world', [
    element('layout-text.active_health', '200 / 1000'),
    element('layout-routine.heal'),
    element('layout-routine.explore'),
  ]);
  assert.equal(healthRatio(low), 0.2);
  assert.equal(continuousRecovery(low).choice, 'layout-routine.heal');
  assert.equal(continuousRecovery(low, { allowHeal: false }).choice, 'layout-routine.explore');

  const world = observation('world', [
    element('layout-routine.track_quest'),
    element('layout-routine.explore'),
    element('layout-routine.approach'),
  ]);
  assert.equal(continuousRecovery(world, { index: 0 }).choice, 'layout-routine.track_quest');
  assert.equal(continuousRecovery(world, { index: 1 }).choice, 'layout-routine.explore');
  assert.match(continuousGoal('Play').toLowerCase(), /continuous play mode/);
});

test('continuous agent turns model completion into activity and runs to its total step limit', async () => {
  let frame = 0;
  const actions = [];
  const device = {
    assertReady: async () => {},
    listApps: async () => [],
    observe: async () =>
      observation(
        'world',
        [
          element('layout-text.quest_distance', '20m'),
          element('layout-routine.explore'),
          element('layout-routine.approach'),
        ],
        frame++,
      ),
    act: async (action) => {
      actions.push(action);
      return { routine: { routine: 'explore', status: 'walked', moved: true } };
    },
  };
  const cycles = [];
  const result = await runContinuousAgent({
    device,
    policy: { decide: async () => ({ status: 'done' }) },
    goal: 'Advance quests',
    execute: true,
    maxSteps: 5,
    cycleSteps: 2,
    settleTimeoutMs: 0,
    onCycle: (event) => cycles.push(event),
  });
  assert.equal(result.status, 'continuous_limit');
  assert.equal(result.steps, 5);
  assert.equal(result.cycles, 3);
  assert.equal(actions.length, 5);
  assert.ok(actions.every((action) => action.type === 'tap-element'));
  assert.deepEqual(
    cycles.map((event) => event.result.steps),
    [2, 2, 1],
  );
});
