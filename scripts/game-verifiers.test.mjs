import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promptCount, verifyPromptPickups } from './game-verifiers.mjs';

const at = (screen, item) => ({
  layout: { screen },
  elements: item ? [{ id: 'layout-text.obtained_item', text: item }] : [],
});
const tap = (step, elementId, label = elementId) => ({
  event: 'action_executed',
  step,
  action: { type: 'tap-element', elementId },
  label,
});
const trace = (initial, steps, status = 'done') => [
  { event: 'observation', step: null, initial: true, observation: initial },
  ...steps.flatMap(([action, observation]) => [
    action,
    { event: 'observation', step: action.step, observation },
  ]),
  { event: 'result', status },
];

test('prompt counts come from the detected Genshin screen', () => {
  assert.equal(promptCount(at('world_prompts_3')), 3);
  assert.equal(promptCount(at('world')), 0);
  assert.equal(promptCount(at('world_talk')), 1);
  assert.equal(promptCount(at('unknown')), null);
  assert.equal(promptCount(at('menu')), null);
});

test('one pickup is verified from the trace and a fresh frame, not from DONE', () => {
  const events = trace(at('world_prompts_2'), [
    [tap(0, 'layout.prompt_1_of_2'), at('world_prompts_1', '树莓×1')],
  ]);
  const report = verifyPromptPickups({ events, final: at('world_prompts_1'), expect: 'one' });
  assert.equal(report.verified, true, report.reasons.join('; '));
  assert.equal(report.modelStatus, 'done');
  assert.deepEqual(report.pickups, [
    { step: 0, from: 2, to: 1, confirmed: true, obtained: '树莓×1' },
  ]);

  // The same claim fails if the list changed again afterwards or a second pickup happened.
  assert.equal(verifyPromptPickups({ events, final: at('world'), expect: 'one' }).verified, false);
  const twice = trace(at('world_prompts_2'), [
    [tap(0, 'layout.prompt_1_of_2'), at('world_prompts_1')],
    [tap(1, 'layout.prompt_1'), at('world')],
  ]);
  assert.equal(
    verifyPromptPickups({ events: twice, final: at('world'), expect: 'one' }).verified,
    false,
  );
});

test('emptying the list must not involve moving away or unconfirmed taps', () => {
  const cleared = trace(
    at('world_prompts_2'),
    [
      [tap(0, 'layout.prompt_1_of_2'), at('world_prompts_1')],
      [tap(1, 'layout.prompt_1'), at('world')],
    ],
    'blocked',
  );
  const report = verifyPromptPickups({ events: cleared, final: at('world'), expect: 'all' });
  assert.equal(report.verified, true, report.reasons.join('; '));
  assert.equal(report.modelStatus, 'blocked');

  // A prompt list that vanished because the character sprinted away is not a pickup.
  const walkedAway = trace(at('world_prompts_2'), [
    [tap(0, 'layout.prompt_1_of_2'), at('world_prompts_1')],
    [tap(1, 'layout.sprint', 'Sprint'), at('world')],
  ]);
  const moved = verifyPromptPickups({ events: walkedAway, final: at('world'), expect: 'all' });
  assert.equal(moved.verified, false);
  assert.ok(moved.reasons.some((r) => /Sprint/.test(r)));

  // An unknown frame after a tap, a conversation start, or an unstable end cannot be confirmed.
  const unknown = trace(at('world_prompts_1'), [[tap(0, 'layout.prompt_1'), at('unknown')]]);
  assert.equal(
    verifyPromptPickups({ events: unknown, final: at('world'), expect: 'all' }).verified,
    false,
  );
  assert.equal(
    verifyPromptPickups({
      events: trace(at('world_talk'), []),
      final: at('world_talk'),
      expect: 'all',
    }).verified,
    false,
  );
  assert.throws(() => verifyPromptPickups({ events: cleared, final: at('world') }), /expect/);
});

test('a found pickup may follow exploring, but not a blind tap or a conversation', () => {
  const routine = (step, status) => ({
    ...tap(step, 'layout-routine.explore', 'Explore'),
    routine: { status },
  });
  const events = trace(at('world'), [
    [routine(0, 'timeout'), at('world')],
    [routine(1, 'found'), at('world_prompts_1')],
    [tap(2, 'layout.prompt_1'), at('world', '蘑菇×1')],
  ]);
  const report = verifyPromptPickups({ events, final: at('world'), expect: 'found' });
  assert.equal(report.verified, true, report.reasons.join('; '));
  assert.deepEqual(report.routines, [
    { step: 0, status: 'timeout' },
    { step: 1, status: 'found' },
  ]);

  const none = trace(at('world'), [[routine(0, 'timeout'), at('world')]], 'done');
  assert.equal(
    verifyPromptPickups({ events: none, final: at('world'), expect: 'found' }).verified,
    false,
  );
  const talk = trace(at('world'), [
    [routine(0, 'found'), at('world_talk')],
    [tap(1, 'layout.prompt_1'), at('dialogue')],
  ]);
  assert.equal(
    verifyPromptPickups({ events: talk, final: at('dialogue'), expect: 'found' }).verified,
    false,
  );
  // Routines are only accepted when searching is part of the goal.
  assert.equal(verifyPromptPickups({ events, final: at('world'), expect: 'all' }).verified, false);
});
