import { runAgent } from './agent.mjs';

const TERMINAL_RECOVERY = new Set([
  'blocked',
  'done',
  'loading_timeout',
  'no_progress',
  'stuck',
  'unstable_screen',
]);

const WORLD_SCREENS = new Set([
  'world',
  'world_talk',
  'world_prompts_1',
  'world_prompts_2',
  'world_prompts_3',
  'world_prompts_4',
  'world_prompts_5',
  'world_climbing',
  'world_swimming',
]);

const BACK_SCREENS = new Set(['confirm_dialog', 'menu', 'quest_log', 'quest_map', 'world_map']);

export function continuousGoal(goal) {
  return `${goal.trim()}

Continuous play mode: keep the character actively playing after one objective finishes. Prefer
making progress on a tracked quest; otherwise track a quest, explore, approach enemies, interact,
fight, or continue dialogue. Recover from defeat and leave menus that block play. DONE means this
single objective is complete, not that continuous play should stop.`;
}

export function healthRatio(observation) {
  const text = observation.elements
    ?.find((element) => element.id === 'layout-text.active_health')
    ?.text?.replace(/\s/gu, '');
  const match = text?.match(/(\d+)\/(\d+)/u);
  if (!match) return null;
  const current = Number(match[1]);
  const maximum = Number(match[2]);
  return maximum > 0 && current <= maximum ? current / maximum : null;
}

const actionDecision = (elementId, reason) => ({
  status: 'action',
  operation: 'TAP',
  choice: elementId,
  action: { type: 'tap-element', elementId },
  label: `Continuous-play recovery: ${reason}`,
  supervised: true,
  reason,
});

function available(observation, id) {
  return observation.elements?.some((element) => element.id === id && element.clickable);
}

export function continuousRecovery(
  observation,
  { reason = 'continue', index = 0, skip = new Set(), allowHeal = true } = {},
) {
  const screen = observation.layout?.screen;
  const pick = (ids, why) => {
    const id = ids.find((candidate) => !skip.has(candidate) && available(observation, candidate));
    return id ? actionDecision(id, why) : null;
  };

  if (screen === 'defeated')
    return pick(['layout.revive_defeated'], 'revive the defeated character');
  if (screen === 'defeated_choice')
    return pick(['layout.revive_defeated_choice'], 'revive the defeated party');
  if (screen === 'dialogue')
    return pick(['layout-routine.dialogue'], 'continue the current dialogue');
  if (screen === 'dialogue_choice')
    return pick(
      ['layout.dialogue_option_1', 'layout.dialogue_option_2'],
      'choose a dialogue reply and keep playing',
    );
  if (BACK_SCREENS.has(screen))
    return {
      status: 'action',
      operation: 'BACK',
      choice: 'BACK',
      action: { type: 'global', name: 'back' },
      label: 'Continuous-play recovery: return to the open world',
      supervised: true,
      reason,
    };
  if (!WORLD_SCREENS.has(screen)) return null;

  if (allowHeal && healthRatio(observation) !== null && healthRatio(observation) <= 0.25) {
    const heal = pick(['layout-routine.heal'], 'restore low health at a Statue of The Seven');
    if (heal) return heal;
  }
  const prompt = observation.elements
    ?.map((element) => element.id)
    .find((id) => id.startsWith('layout.prompt_') && !skip.has(id));
  if (prompt) return actionDecision(prompt, `${reason}; use the visible world interaction`);

  const hasQuest = observation.elements?.some(
    (element) => element.id === 'layout-text.quest_distance',
  );
  const choices = hasQuest
    ? [
        'layout-routine.explore',
        'layout-routine.approach',
        'layout-routine.navigate',
        'layout-routine.teleport',
      ]
    : ['layout-routine.track_quest', 'layout-routine.explore', 'layout-routine.approach'];
  const rotated = choices.map((_, offset) => choices[(index + offset) % choices.length]);
  return pick(rotated, `${reason}; switch to another useful activity`);
}

function addTimings(total, timings = {}) {
  for (const [key, value] of Object.entries(timings))
    if (key !== 'wallMs' && Number.isFinite(value)) total[key] = (total[key] ?? 0) + value;
}

export async function runContinuousAgent({
  maxSteps = 100,
  cycleSteps = 12,
  onCycle = () => {},
  ...options
}) {
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > 10_000)
    throw new Error('maxSteps must be 1–10000 in continuous mode.');
  if (!Number.isSafeInteger(cycleSteps) || cycleSteps < 1 || cycleSteps > 100)
    throw new Error('cycleSteps must be 1–100.');

  const started = performance.now();
  const goal = continuousGoal(options.goal);
  const timings = {};
  let steps = 0;
  let cycles = 0;
  let recoveryIndex = 0;
  let pendingReason;
  let lastResult;
  let lastFallback;
  let attemptedHealth;

  while (steps < maxSteps) {
    let firstDecision = true;
    const policy = {
      decide: async (context) => {
        const ratio = healthRatio(context.observation);
        const healthKey = ratio === null ? null : ratio.toFixed(3);
        const allowHeal = healthKey !== attemptedHealth;
        const skip = new Set(lastFallback ? [lastFallback] : []);
        const recovery =
          firstDecision || ratio !== null
            ? continuousRecovery(context.observation, {
                reason: pendingReason ?? 'continue playing',
                index: recoveryIndex,
                skip,
                allowHeal,
              })
            : null;
        firstDecision = false;
        if (recovery && (pendingReason || recovery.choice === 'layout-routine.heal')) {
          lastFallback = recovery.choice;
          if (recovery.choice === 'layout-routine.heal') attemptedHealth = healthKey;
          pendingReason = undefined;
          return recovery;
        }

        const decision = await options.policy.decide({ ...context, goal });
        if (!['done', 'blocked'].includes(decision.status)) return decision;
        const fallback = continuousRecovery(context.observation, {
          reason: decision.status,
          index: recoveryIndex++,
          skip,
          allowHeal,
        });
        if (!fallback) return decision;
        lastFallback = fallback.choice;
        if (fallback.choice === 'layout-routine.heal') attemptedHealth = healthKey;
        return fallback;
      },
    };
    const offset = steps;
    const result = await runAgent({
      ...options,
      policy,
      goal,
      maxSteps: Math.min(cycleSteps, maxSteps - steps),
      onStep: (event) => options.onStep?.({ ...event, step: offset + event.step, cycle: cycles }),
      onAction: (event) =>
        options.onAction?.({ ...event, step: offset + event.step, cycle: cycles }),
      onObservation: (event) =>
        options.onObservation?.({
          ...event,
          step: event.step === null ? (cycles === 0 ? null : offset) : offset + event.step,
          cycle: cycles,
          initial: cycles === 0 ? event.initial : false,
        }),
    });
    cycles++;
    steps += result.steps;
    addTimings(timings, result.timings);
    lastResult = result;
    await onCycle({ cycle: cycles - 1, offset, result });

    if (result.status === 'preview' || !options.execute)
      return { ...result, cycles, steps, continuous: true };
    if (steps >= maxSteps) break;
    if (!TERMINAL_RECOVERY.has(result.status) && result.status !== 'step_limit')
      return { ...result, cycles, steps, continuous: true };

    pendingReason = result.status;
    recoveryIndex++;
    if (result.steps === 0) {
      const recovery = continuousRecovery(result.observation, {
        reason: result.status,
        index: recoveryIndex,
        skip: new Set(lastFallback ? [lastFallback] : []),
        allowHeal: false,
      });
      if (!recovery)
        return {
          ...result,
          status: 'continuous_blocked',
          cycles,
          steps,
          continuous: true,
        };
    }
  }

  return {
    ...lastResult,
    status: 'continuous_limit',
    cycles,
    steps,
    continuous: true,
    timings: {
      ...timings,
      wallMs: Math.round((performance.now() - started) * 10) / 10,
    },
  };
}
