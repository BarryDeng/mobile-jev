import { rgbAt } from './png.mjs';

// Routines are code-owned, bounded input loops for things Jev cannot drive step by step (a held
// joystick). Jev only chooses to start one; every routine ends with a status and evidence.
export const ROUTINE_TYPES = ['explore', 'dialogue', 'combat'];

// Mean absolute RGB difference over a screen-space rectangle, sampled on a coarse grid.
export function regionMotion(a, b, bounds, screen, step = 3) {
  const sx = a.width / screen.width,
    sy = a.height / screen.height;
  let sum = 0,
    n = 0;
  for (let y = Math.round(bounds.top * sy); y < Math.round(bounds.bottom * sy); y += step)
    for (let x = Math.round(bounds.left * sx); x < Math.round(bounds.right * sx); x += step) {
      const p = rgbAt(a, x, y),
        q = rgbAt(b, x, y);
      sum += Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]);
      n++;
    }
  return n ? sum / n / 3 : 0;
}

/**
 * Walk in random directions while holding the joystick, checking a frame after each move.
 * Stops on a stop screen (only once the walk has left any stop screen it started on), when the
 * screen leaves the allowed set, when the minimap stops moving `stuckLimit` times, or at maxMs.
 *
 * ctx: { routine, joystick: {x, y, radius}, minimap: bounds, buttonCenter(id), screen,
 *        frame() -> {image, screen}, touch(event, x, y), sleep(ms), now(), random() }
 */
export async function explore(ctx) {
  const { routine, joystick, minimap, screen, frame, touch, sleep, now, random } = ctx;
  const maxMs = routine.maxMs ?? 15_000;
  const stuckLimit = routine.stuckLimit ?? 3;
  const threshold = routine.motionThreshold ?? 3;
  const stop = new Set(routine.stopScreens ?? []);
  const allowed = new Set(routine.screens ?? []);
  const started = now();
  const counts = {
    frames: 0,
    turns: 0,
    stuck: 0,
    recoveries: 0,
    backsteps: 0,
    overshoots: 0,
    motion: [],
  };
  let held = null,
    grace = false;
  const result = (status, extra = {}) => ({
    routine: routine.id,
    status,
    ms: Math.round(now() - started),
    ...counts,
    ...extra,
  });
  const release = async () => {
    if (!held) return;
    const [x, y] = held;
    held = null;
    await touch('up', x, y);
  };
  const press = async (angle) => {
    const reach = joystick.radius * (routine.deflection ?? 1);
    const point = [
      Math.round(joystick.x + reach * Math.cos(angle)),
      Math.round(joystick.y - reach * Math.sin(angle)),
    ];
    // Starting from rest, the character accelerates and the minimap lags a frame behind.
    if (!held) {
      await touch('down', joystick.x, joystick.y);
      grace = true;
    }
    await touch('move', ...point);
    held = point;
  };
  const tapButton = async (id) => {
    await release();
    const { x, y } = ctx.buttonCenter(id);
    await touch('down', x, y);
    await touch('up', x, y);
  };
  const segment = () => 2 + Math.floor(random() * 3);

  let angle = random() * 2 * Math.PI;
  let previous = await frame();
  let armed = !stop.has(previous.screen);
  let unknown = 0,
    recovering = 0,
    still = 0;
  let left = segment();
  const turns = new Set(routine.turnScreens ?? []);
  // A prompt seen while moving may be out of reach once the character stops: confirm it at rest,
  // then with one short step back along the path.
  const confirmStop = async () => {
    await release();
    let check = await frame();
    if (stop.has(check.screen)) return check;
    await press(angle + Math.PI);
    await sleep(routine.backstepMs ?? 400);
    await release();
    check = await frame();
    counts.backsteps++;
    return stop.has(check.screen) ? check : null;
  };
  try {
    await press(angle);
    while (now() - started < maxMs) {
      const current = await frame();
      counts.frames++;
      if (stop.has(current.screen)) {
        if (armed) {
          const confirmed = await confirmStop();
          if (confirmed) return result('found', { screen: confirmed.screen });
          counts.overshoots++;
          previous = await frame();
          await press(angle);
          continue;
        }
      } else armed = true;
      if (current.screen === null) {
        if (++unknown >= 2) return result('interrupted', { screen: 'unknown' });
        continue;
      }
      unknown = 0;
      // Entering e.g. water: the character came from land, so head back the way it came.
      if (turns.has(current.screen) && !turns.has(previous.screen)) {
        angle += Math.PI;
        counts.turns++;
        await press(angle);
        left = segment();
      }
      const recover = routine.recover?.[current.screen];
      if (recover) {
        // e.g. climbing: first keep climbing up (low ledges, shores), then drop and turn back.
        if (++recovering === 1) {
          angle = Math.PI / 2;
          await press(angle);
        }
        if (recovering < (routine.recoverAfter ?? 1)) continue;
        recovering = 0;
        counts.recoveries++;
        if (++counts.stuck >= stuckLimit) return result('stuck', { screen: current.screen });
        await tapButton(recover);
        await sleep(routine.recoverMs ?? 800);
        angle += Math.PI;
        counts.turns++;
        previous = await frame();
        await press(angle);
        left = segment();
        continue;
      }
      recovering = 0;
      if (!allowed.has(current.screen) && !stop.has(current.screen))
        return result('interrupted', { screen: current.screen });
      const motion = regionMotion(previous.image, current.image, minimap, screen);
      const full = { left: 0, top: 0, right: screen.width, bottom: screen.height };
      // A game that stopped rendering (e.g. a hung emulator) returns identical frames; a single
      // identical pair also happens during respawn fades, so require two in a row.
      if (motion === 0 && regionMotion(previous.image, current.image, full, screen, 12) === 0) {
        if (++still >= 2) return result('frozen', { screen: current.screen });
      } else still = 0;
      counts.motion.push(Math.round(motion * 10) / 10);
      previous = current;
      if (grace) grace = false;
      else if (motion < threshold) {
        if (++counts.stuck >= stuckLimit) return result('stuck', { screen: current.screen });
        if (routine.stuckButton) await tapButton(routine.stuckButton);
        angle += Math.PI / 2 + random() * Math.PI;
        counts.turns++;
        await press(angle);
        left = segment();
        continue;
      }
      if (--left <= 0) {
        angle += (random() - 0.5) * ((2 * Math.PI) / 3);
        counts.turns++;
        await press(angle);
        left = segment();
      }
    }
    return result('timeout');
  } finally {
    await release();
  }
}

const FULL = (screen) => ({ left: 0, top: 0, right: screen.width, bottom: screen.height });
const identical = (a, b, screen) => regionMotion(a, b, FULL(screen), screen, 12) === 0;

const tapButton = async (ctx, id) => {
  const { x, y } = ctx.buttonCenter(id);
  await ctx.touch('down', x, y);
  await ctx.touch('up', x, y);
};

// Sampled pixels within `tolerance` (per channel) of `rgb` in a screen-space rectangle.
export function colorPixels(image, bounds, screen, rgb, tolerance, step = 4) {
  const sx = image.width / screen.width,
    sy = image.height / screen.height;
  let n = 0;
  for (let y = Math.round(bounds.top * sy); y < Math.round(bounds.bottom * sy); y += step)
    for (let x = Math.round(bounds.left * sx); x < Math.round(bounds.right * sx); x += step) {
      const p = rgbAt(image, x, y);
      if (p.every((v, i) => Math.abs(v - rgb[i]) <= tolerance)) n++;
    }
  return n;
}

const tracker = (routine, now) => {
  const started = now();
  const counts = { frames: 0 };
  const result = (status, extra = {}) => ({
    routine: routine.id,
    status,
    ms: Math.round(now() - started),
    ...counts,
    ...extra,
  });
  return { started, counts, result };
};

/**
 * Advance a conversation by tapping `button` until reply options appear (`stopScreens`: Jev
 * chooses), a `doneScreens` screen returns (the conversation ended), or it stops changing.
 * Unknown frames (cutscene fades) are waited out without tapping, up to `unknownLimit`.
 */
export async function dialogue(ctx) {
  const { routine, screen, frame, sleep, now } = ctx;
  const { counts, started, result } = tracker(routine, now);
  counts.taps = 0;
  const maxMs = routine.maxMs ?? 60_000;
  const stop = new Set(routine.stopScreens ?? []);
  const done = new Set(routine.doneScreens ?? []);
  const allowed = new Set(routine.screens);
  let current = await frame();
  let unknown = 0,
    still = 0;
  for (;;) {
    if (stop.has(current.screen)) return result('choice', { screen: current.screen });
    if (done.has(current.screen)) return result('done', { screen: current.screen });
    if (current.screen === null) {
      if (++unknown > (routine.unknownLimit ?? 5))
        return result('interrupted', { screen: 'unknown' });
    } else if (!allowed.has(current.screen)) {
      return result('interrupted', { screen: current.screen });
    } else {
      unknown = 0;
      await tapButton(ctx, routine.button);
      counts.taps++;
    }
    if (now() - started >= maxMs) return result('timeout', { screen: current.screen ?? 'unknown' });
    await sleep(routine.intervalMs ?? 300);
    const next = await frame();
    counts.frames++;
    // A tap always redraws a live conversation; three unchanged frames mean a hung game.
    if (next.screen !== null && identical(current.image, next.image, screen)) {
      if (++still >= 3) return result('frozen', { screen: next.screen });
    } else still = 0;
    current = next;
  }
}

/**
 * Fight with a fixed rotation: skill, burst, `attackTaps` attacks, then switch to the next
 * teammate row (rows 1, 2, 3 in turn visit every party member even though the list shifts).
 * With `enemy` (a colour such as red HP bars inside `enemyBounds`) it stops with `clear` after
 * `clearFrames` frames without it, or `no_enemy` if none was visible at the start; otherwise it
 * fights until maxMs. It stops with `interrupted` when the screen leaves the allowed set.
 */
export async function combat(ctx) {
  const { routine, screen, frame, sleep, now, enemyBounds } = ctx;
  const { counts, started, result } = tracker(routine, now);
  Object.assign(counts, { rounds: 0, switches: 0, enemy: [] });
  const maxMs = routine.maxMs ?? 30_000;
  const allowed = new Set(routine.screens);
  const switches = routine.switchButtons ?? [];
  const { enemy } = routine;
  let current = await frame();
  let unknown = 0,
    still = 0,
    clear = 0;
  for (;;) {
    if (current.screen === null) {
      if (++unknown >= 2) return result('interrupted', { screen: 'unknown' });
    } else if (!allowed.has(current.screen)) {
      return result('interrupted', { screen: current.screen });
    } else {
      unknown = 0;
      if (enemy) {
        const seen = colorPixels(current.image, enemyBounds, screen, enemy.rgb, enemy.tolerance);
        counts.enemy.push(seen);
        if (seen < (enemy.minPixels ?? 1)) {
          if (counts.rounds === 0) return result('no_enemy', { screen: current.screen });
          if (++clear >= (routine.clearFrames ?? 2))
            return result('clear', { screen: current.screen });
        } else clear = 0;
      }
    }
    if (now() - started >= maxMs) return result('timeout', { screen: current.screen ?? 'unknown' });
    if (current.screen !== null) {
      if (routine.skill) {
        await tapButton(ctx, routine.skill);
        await sleep(routine.castMs ?? 400);
      }
      if (routine.burst) {
        await tapButton(ctx, routine.burst);
        await sleep(routine.burstMs ?? 400);
      }
      for (let i = 0; i < (routine.attackTaps ?? 4); i++) {
        await tapButton(ctx, routine.attack);
        await sleep(routine.attackMs ?? 150);
      }
      counts.rounds++;
      if (switches.length) {
        await tapButton(ctx, switches[counts.switches++ % switches.length]);
        await sleep(routine.switchMs ?? 300);
      }
    } else await sleep(300);
    const next = await frame();
    counts.frames++;
    if (identical(current.image, next.image, screen)) {
      if (++still >= 2) return result('frozen', { screen: next.screen ?? 'unknown' });
    } else still = 0;
    current = next;
  }
}

export const ROUTINES = { explore, dialogue, combat };
