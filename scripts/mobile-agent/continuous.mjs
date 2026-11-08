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

const BACK_SCREENS = new Set([
  'confirm_dialog',
  'menu',
  'quest_log',
  'quest_map',
  'time_adjusted',
  'world_map',
]);

export function continuousGoal(goal) {
  return `${goal.trim()}

Continuous play mode: keep the character actively playing after one objective finishes. Prefer
making progress on a tracked quest; otherwise track a quest, explore, approach enemies, interact,
fight, or continue dialogue. Recover from defeat and leave menus that block play. DONE means this
single objective is complete, not that continuous play should stop.`;
}

export function healthRatio(observation) {
  const reading = healthReading(observation);
  return reading ? reading.current / reading.maximum : null;
}

function healthReading(observation) {
  const text = observation.elements
    ?.find((element) => element.id === 'layout-text.active_health')
    ?.text?.replace(/\s/gu, '');
  const match = text?.match(/(\d+)\/(\d+)/u);
  if (!match) return null;
  const current = Number(match[1]);
  const maximum = Number(match[2]);
  return maximum > 0 && current <= maximum ? { current, maximum } : null;
}

/**
 * Why code should start a fight now, or undefined. Health falling between two observations of the
 * same character (equal maximum HP) means enemies are hitting it, even when none is on screen; an
 * approach that code verified as `near` already put an enemy in range. A drop across a combat
 * routine is damage taken in that fight, not a new attack.
 */
export function fightReason(observation, { previous, lastRoutine, minDrop = 0.02 } = {}) {
  if (!WORLD_SCREENS.has(observation.layout?.screen)) return undefined;
  if (!available(observation, 'layout-routine.combat')) return undefined;
  const now = healthReading(observation);
  if (
    now &&
    previous &&
    lastRoutine?.routine !== 'combat' &&
    now.maximum === previous.maximum &&
    previous.current - now.current >= minDrop * now.maximum
  )
    return `health fell from ${previous.current} to ${now.current}/${now.maximum}, so enemies are attacking: fight back`;
  if (observation.layout?.threat === 'attacked')
    return 'health is falling, so enemies are attacking: fight back';
  if (lastRoutine?.routine === 'approach' && lastRoutine.status === 'near')
    return 'the approach reached an enemy: fight it';
  if (observation.layout?.threat === 'enemy_near')
    return 'an enemy is within fighting range: fight it';
  return undefined;
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
  { reason = 'continue', index = 0, skip = new Set(), allowHeal = true, downed = false } = {},
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
  if (screen === 'time_adjust')
    return pick(['layout.time_confirm'], 'confirm the time the quest is waiting for');
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

  // Teleporting is impossible mid-fight and walking away gets the party killed: fight first.
  const threat = observation.layout?.threat;
  if (threat && available(observation, 'layout-routine.combat'))
    return actionDecision(
      'layout-routine.combat',
      threat === 'attacked'
        ? 'health is falling, so enemies are attacking: fight back'
        : 'an enemy is within fighting range: fight it',
    );
  if (!threat && downed) {
    // Combat found downed teammates and no food to revive them: a Statue revives the party.
    const heal = pick(['layout-routine.heal'], 'revive downed teammates at a Statue of The Seven');
    if (heal) return heal;
  }
  if (
    !threat &&
    allowHeal &&
    healthRatio(observation) !== null &&
    healthRatio(observation) <= 0.25
  ) {
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

/**
 * Bring back the game client continuous play started in when another app (the launcher, or a
 * second client of the same game whose icon has the same name) is in the foreground.
 */
export function returnToGame(observation, gamePackage) {
  const current = observation.phone?.packageName;
  if (!gamePackage || !current || current === gamePackage) return null;
  return {
    status: 'action',
    operation: 'OPEN_APP',
    choice: `open_${gamePackage}`,
    action: { type: 'open-app', packageName: gamePackage },
    label: `Continuous-play recovery: return to the game (${gamePackage}) from ${current}`,
    supervised: true,
    reason: 'the game left the foreground',
  };
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
  let gamePackage;
  let lastHealth;
  let lastRoutineResult;

  while (steps < maxSteps) {
    const policy = {
      decide: async (context) => {
        // The first recognised game screen fixes which client is being played.
        if (!gamePackage && context.observation.layout?.screen)
          gamePackage = context.observation.phone?.packageName;
        const back = returnToGame(context.observation, gamePackage);
        if (back) return back;
        const previous = lastHealth;
        lastHealth = healthReading(context.observation) ?? lastHealth;
        const fight = fightReason(context.observation, {
          previous,
          lastRoutine: lastRoutineResult,
        });
        if (fight) {
          pendingReason = undefined;
          lastFallback = 'layout-routine.combat';
          return actionDecision('layout-routine.combat', fight);
        }
        const ratio = healthRatio(context.observation);
        const healthKey = ratio === null ? null : ratio.toFixed(3);
        const allowHeal = healthKey !== attemptedHealth;
        const skip = new Set(lastFallback ? [lastFallback] : []);
        // Healing and route choices are Jev's (see the layout playbook). Code steps in only when
        // health shows an attack, or after a cycle ended with Jev reporting done or blocked.
        const threat = context.observation.layout?.threat;
        const recovery =
          pendingReason || threat === 'attacked'
            ? continuousRecovery(context.observation, {
                reason: pendingReason ?? 'continue playing',
                index: recoveryIndex,
                skip,
                allowHeal: false,
              })
            : null;
        const attacked = recovery?.choice === 'layout-routine.combat' && threat === 'attacked';
        if (recovery && (pendingReason || attacked)) {
          lastFallback = recovery.choice;
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
          downed: Boolean(context.observation.layout?.downed),
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
      onAction: (event) => {
        lastRoutineResult = event.routine;
        return options.onAction?.({ ...event, step: offset + event.step, cycle: cycles });
      },
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

    // A cycle that only ran out of steps hands the next step back to Jev; code picks an activity
    // only after Jev reported done or blocked.
    pendingReason = result.status === 'step_limit' ? undefined : result.status;
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
