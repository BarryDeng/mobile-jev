// Independent outcome checks for Genshin interaction-prompt pickups (layouts/genshin-impact.json).
// They read a run trace plus a fresh observation and never trust the model's DONE on its own.

// Entries in the interaction prompt list, from the detected layout screen. null: not visible.
export function promptCount(observation) {
  const screen = observation?.layout?.screen;
  if (screen === 'world') return 0;
  if (screen === 'world_talk') return 1;
  const match = /^world_prompts_([1-5])$/.exec(screen ?? '');
  return match ? Number(match[1]) : null;
}

const obtained = (observation) =>
  observation?.elements?.find((e) => e.id === 'layout-text.obtained_item')?.text;

const isPromptTap = (action) =>
  action?.type === 'tap-element' && /^layout\.prompt_/.test(action.elementId ?? '');

const isRoutineTap = (action) =>
  action?.type === 'tap-element' && /^layout-routine\./.test(action.elementId ?? '');

// expect: 'one' picks exactly one entry; 'all' empties the list; 'found' may start anywhere, may
// search with layout routines (explore) and needs at least one pickup. `final` is a fresh
// observation taken after the run, so the result is confirmed on two consecutive frames.
export function verifyPromptPickups({ events, final, expect }) {
  if (!['one', 'all', 'found'].includes(expect))
    throw new Error('expect must be one, all or found.');
  const reasons = [];
  const observations = events.filter((e) => e.event === 'observation');
  const initial = observations.find((e) => e.initial)?.observation;
  const result = events.find((e) => e.event === 'result');
  const start = promptCount(initial);
  if (expect !== 'found') {
    if (start === null || start === 0)
      reasons.push('The run did not start on a visible interaction prompt list.');
    if (initial?.layout?.screen === 'world_talk')
      reasons.push('The starting prompt is a conversation, not a pickup.');
  }

  const pickups = [];
  const routines = [];
  let before = initial;
  for (const action of events.filter((e) => e.event === 'action_executed')) {
    const after = observations.find((e) => !e.initial && e.step === action.step)?.observation;
    if (expect === 'found' && isRoutineTap(action.action)) {
      routines.push({ step: action.step, status: action.routine?.status ?? null });
    } else if (!isPromptTap(action.action)) {
      reasons.push(`Step ${action.step} used ${action.label}, which is not a prompt pickup.`);
    } else {
      const [from, to] = [promptCount(before), promptCount(after)];
      const talk = before?.layout?.screen === 'world_talk';
      if (talk) reasons.push(`Step ${action.step} started a conversation, not a pickup.`);
      const confirmed = !talk && from !== null && to !== null && to === from - 1;
      pickups.push({ step: action.step, from, to, confirmed, obtained: obtained(after) });
      if (!confirmed)
        reasons.push(
          `Step ${action.step} tapped a prompt, but the list went from ${from} to ${to}.`,
        );
    }
    before = after;
  }

  const last = promptCount(before);
  const fresh = promptCount(final);
  if (last === null || fresh === null || last !== fresh)
    reasons.push(`The final prompt count was not stable (${last} in the trace, ${fresh} now).`);
  const confirmed = pickups.filter((p) => p.confirmed).length;
  if (expect === 'one') {
    if (pickups.length !== 1 || confirmed !== 1)
      reasons.push(`Expected exactly one confirmed pickup, saw ${confirmed} of ${pickups.length}.`);
    if (start !== null && fresh !== start - 1)
      reasons.push(`Expected ${start - 1} remaining entries, found ${fresh}.`);
  } else if (expect === 'found') {
    if (confirmed < 1) reasons.push('No confirmed pickup happened.');
  } else {
    if (fresh !== 0) reasons.push(`Expected an empty prompt list, found ${fresh} entries.`);
    if (start !== null && confirmed !== start)
      reasons.push(`Expected ${start} confirmed pickups, saw ${confirmed}.`);
  }
  return {
    verified: reasons.length === 0,
    expect,
    modelStatus: result?.status ?? null,
    initialCount: start,
    finalCounts: [last, fresh],
    pickups,
    routines,
    reasons,
  };
}
