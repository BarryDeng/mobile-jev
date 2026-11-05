import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  continuousGoal,
  continuousRecovery,
  fightReason,
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
  assert.equal(
    continuousRecovery(observation('time_adjust', [element('layout.time_confirm')])).choice,
    'layout.time_confirm',
  );
  assert.equal(continuousRecovery(observation('time_adjusted', [])).operation, 'BACK');
  const low = observation('world', [
    element('layout-text.active_health', '200 / 1000'),
    element('layout-routine.heal'),
    element('layout-routine.explore'),
  ]);
  assert.equal(healthRatio(low), 0.2);
  assert.equal(continuousRecovery(low).choice, 'layout-routine.heal');
  assert.equal(continuousRecovery(low, { allowHeal: false }).choice, 'layout-routine.explore');
  // Full health but downed teammates and no food: a Statue revives them.
  const full = observation('world', [
    element('layout-text.active_health', '1000 / 1000'),
    element('layout-routine.heal'),
    element('layout-routine.explore'),
  ]);
  assert.equal(continuousRecovery(full).choice, 'layout-routine.explore');
  assert.equal(continuousRecovery(full, { downed: true }).choice, 'layout-routine.heal');

  const world = observation('world', [
    element('layout-routine.track_quest'),
    element('layout-routine.explore'),
    element('layout-routine.approach'),
  ]);
  assert.equal(continuousRecovery(world, { index: 0 }).choice, 'layout-routine.track_quest');
  assert.equal(continuousRecovery(world, { index: 1 }).choice, 'layout-routine.explore');
  assert.match(continuousGoal('Play').toLowerCase(), /continuous play mode/);
});

test('continuous recovery fights a nearby or attacking enemy before healing', () => {
  const low = (threat) => ({
    ...observation('world', [
      element('layout-text.active_health', '200 / 1000'),
      element('layout-routine.heal'),
      element('layout-routine.combat'),
      element('layout-routine.explore'),
    ]),
    layout: { screen: 'world', signature: 'x', ...(threat ? { threat } : {}) },
  });
  assert.equal(continuousRecovery(low()).choice, 'layout-routine.heal');
  for (const threat of ['attacked', 'enemy_near']) {
    const fight = continuousRecovery(low(threat), { skip: new Set(['layout-routine.combat']) });
    assert.equal(fight.choice, 'layout-routine.combat');
  }
});

test('continuous agent overrides the model with combat while health is falling', async () => {
  const actions = [];
  let n = 0;
  const device = {
    assertReady: async () => {},
    listApps: async () => [],
    observe: async () => ({
      ...observation(
        'world',
        [
          element('layout-text.active_health', '900 / 1000'),
          element('layout-routine.combat'),
          element('layout-routine.explore'),
        ],
        n,
      ),
      layout: { screen: 'world', signature: `layout-${n++}`, threat: 'attacked' },
    }),
    act: async (action) => {
      actions.push(action.elementId);
      return { routine: { routine: 'combat', status: 'clear' } };
    },
  };
  await runContinuousAgent({
    device,
    policy: {
      decide: async () => ({
        status: 'act',
        choice: 'layout-routine.explore',
        action: { type: 'tap-element', elementId: 'layout-routine.explore' },
      }),
    },
    goal: 'Play',
    execute: true,
    maxSteps: 2,
    cycleSteps: 2,
    settleTimeoutMs: 0,
  });
  assert.deepEqual(actions, ['layout-routine.combat', 'layout-routine.combat']);
});

test('continuous agent fights when health falls between routines or an approach reached an enemy', () => {
  const world = (hp, threat) => ({
    ...observation('world', [
      element('layout-text.active_health', hp),
      element('layout-routine.combat'),
      element('layout-routine.explore'),
    ]),
    layout: { screen: 'world', signature: 'x', ...(threat ? { threat } : {}) },
  });
  const previous = { current: 4627, maximum: 9150 };
  assert.match(fightReason(world('3440 / 9150'), { previous }), /health fell/);
  // Another character (different maximum), a fight that just ended, or a tiny change: no attack.
  assert.equal(fightReason(world('3440 / 7301'), { previous }), undefined);
  assert.equal(
    fightReason(world('3440 / 9150'), { previous, lastRoutine: { routine: 'combat' } }),
    undefined,
  );
  assert.equal(fightReason(world('4600 / 9150'), { previous }), undefined);
  assert.match(
    fightReason(world('4627 / 9150'), { lastRoutine: { routine: 'approach', status: 'near' } }),
    /approach reached/,
  );
  assert.match(fightReason(world('4627 / 9150', 'enemy_near')), /within fighting range/);
  assert.equal(fightReason(world('4627 / 9150')), undefined);
  assert.equal(fightReason(observation('world_map'), { previous }), undefined);
});

test('continuous agent reopens its game client instead of letting the model use the launcher', async () => {
  const actions = [];
  const packages = ['game', 'launcher', 'game'];
  let n = 0;
  const device = {
    assertReady: async () => {},
    listApps: async () => [{ packageName: 'game' }, { packageName: 'other.game' }],
    observe: async () => {
      const packageName = packages[Math.min(n, packages.length - 1)];
      const frame = observation(packageName === 'game' ? 'world' : undefined, [], n++);
      return {
        ...frame,
        phone: { packageName },
        layout: packageName === 'game' ? frame.layout : undefined,
      };
    },
    act: async (action) => {
      actions.push(action.type === 'open-app' ? action.packageName : action.elementId);
    },
  };
  let modelCalls = 0;
  await runContinuousAgent({
    device,
    policy: {
      decide: async ({ observation: seen }) => {
        modelCalls++;
        assert.equal(seen.phone.packageName, 'game');
        return {
          status: 'action',
          choice: 'x',
          action: { type: 'tap-element', elementId: `tap-${modelCalls}` },
        };
      },
    },
    goal: 'Play',
    execute: true,
    maxSteps: 3,
    cycleSteps: 3,
    settleTimeoutMs: 0,
  });
  assert.equal(actions[1], 'game');
  assert.equal(actions.filter((a) => a === 'game').length, 1);
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
