import { rgbAt } from './png.mjs';

// Routines are code-owned, bounded input loops for things Jev cannot drive step by step (a held
// joystick). Jev only chooses to start one; every routine ends with a status and evidence.
export const ROUTINE_TYPES = ['explore', 'dialogue', 'combat', 'navigate', 'approach', 'teleport'];

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
  if (ctx.routine.hopMs) return exploreHops(ctx);
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

/**
 * Hop mode (`hopMs`): walk a short hop, release the joystick and check the frame at rest, up to
 * `hops` times. Prompts appear only within a few metres and a moving frame can skip past them, so
 * each check happens standing still. Ends with `walked` after the last hop; `moved` tells the
 * agent that the character got somewhere new, so starting the routine again is progress.
 */
async function exploreHops(ctx) {
  const { routine, joystick, minimap, screen, frame, touch, sleep, now, random } = ctx;
  const maxMs = routine.maxMs ?? 15_000;
  const stuckLimit = routine.stuckLimit ?? 3;
  const threshold = routine.motionThreshold ?? 1.5;
  const stop = new Set(routine.stopScreens ?? []);
  const allowed = new Set(routine.screens ?? []);
  const turns = new Set(routine.turnScreens ?? []);
  const started = now();
  const counts = { frames: 0, hops: 0, turns: 0, stuck: 0, recoveries: 0, motion: [] };
  let pressed = null;
  const result = (status, extra = {}) => ({
    routine: routine.id,
    status,
    ms: Math.round(now() - started),
    moved: counts.motion.some((m) => m >= threshold),
    ...counts,
    ...extra,
  });
  const release = async () => {
    if (!pressed) return;
    const [x, y] = pressed;
    pressed = null;
    await touch('up', x, y);
  };
  const hop = async (angle) => {
    const reach = joystick.radius * (routine.deflection ?? 1);
    const point = [
      Math.round(joystick.x + reach * Math.cos(angle)),
      Math.round(joystick.y - reach * Math.sin(angle)),
    ];
    await touch('down', joystick.x, joystick.y);
    pressed = [joystick.x, joystick.y];
    await touch('move', ...point);
    pressed = point;
    await sleep(routine.hopMs);
    await release();
    counts.hops++;
  };
  const tapButton = async (id) => {
    const { x, y } = ctx.buttonCenter(id);
    await touch('down', x, y);
    await touch('up', x, y);
  };
  const turn = (by) => {
    angle += by;
    counts.turns++;
  };

  // `forwardDeg`: walk roughly where the camera faces (± half of it) so repeated explores
  // cover ground instead of wandering in circles; otherwise any direction.
  const spread = routine.forwardDeg === undefined ? null : (routine.forwardDeg * Math.PI) / 180;
  const forward = () => Math.PI / 2 + (random() - 0.5) * spread;
  let angle = spread === null ? random() * 2 * Math.PI : forward();
  let previous = await frame();
  // A prompt already on screen at the start is visible to Jev; report only one reached anew.
  let armed = !stop.has(previous.screen);
  const watchEnemies = routine.enemyStop && ctx.enemy;
  const enemiesIn = (image) =>
    enemyBars(image, ctx.enemy.bounds, screen, ctx.enemy, ctx.enemy.scale);
  // Likewise enemies: Jev already sees bars visible at the start; stop only for new ones.
  let enemyArmed = !watchEnemies || enemiesIn(previous.image).length === 0;
  let unknown = 0,
    recovering = 0,
    still = 0;
  try {
    while (counts.hops < (routine.hops ?? 5)) {
      if (now() - started >= maxMs) return result('timeout');
      await hop(angle);
      const current = await frame();
      counts.frames++;
      if (current.screen === null) {
        if (++unknown >= 2) return result('interrupted', { screen: 'unknown' });
        continue;
      }
      unknown = 0;
      if (stop.has(current.screen)) {
        if (armed) return result('found', { screen: current.screen });
      } else armed = true;
      if (watchEnemies && allowed.has(current.screen)) {
        const bars = enemiesIn(current.image);
        if (!bars.length) enemyArmed = true;
        else if (enemyArmed)
          return result('enemy', { screen: current.screen, enemies: bars.length });
      }
      const recover = routine.recover?.[current.screen];
      if (recover) {
        // e.g. climbing: keep climbing up for a few hops (low ledges), then drop and turn back.
        if (++recovering === 1) angle = Math.PI / 2;
        if (recovering < (routine.recoverAfter ?? 1)) continue;
        recovering = 0;
        counts.recoveries++;
        if (++counts.stuck >= stuckLimit) return result('stuck', { screen: current.screen });
        await tapButton(recover);
        await sleep(routine.recoverMs ?? 800);
        turn(Math.PI);
        previous = await frame();
        continue;
      }
      recovering = 0;
      if (!allowed.has(current.screen) && !stop.has(current.screen))
        return result('interrupted', { screen: current.screen });
      if (turns.has(current.screen) && !turns.has(previous.screen)) turn(Math.PI);
      const motion = regionMotion(previous.image, current.image, minimap, screen);
      const full = { left: 0, top: 0, right: screen.width, bottom: screen.height };
      if (motion === 0 && regionMotion(previous.image, current.image, full, screen, 12) === 0) {
        if (++still >= 2) return result('frozen', { screen: current.screen });
      } else still = 0;
      counts.motion.push(Math.round(motion * 10) / 10);
      previous = current;
      if (motion < threshold) {
        if (++counts.stuck >= stuckLimit) return result('stuck', { screen: current.screen });
        if (routine.stuckButton) await tapButton(routine.stuckButton);
        turn(Math.PI / 2 + random() * Math.PI);
      } else if (spread !== null) {
        angle = forward();
        counts.turns++;
      } else turn((random() - 0.5) * ((2 * Math.PI) / 3));
    }
    return result('walked');
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
/**
 * Enemy HP bars: thin horizontal runs of `enemy.rgb` inside `bounds`. Rows are sampled every
 * `step` pixels; a run needs `minWidth` px (gaps up to one sample are bridged) and runs on nearby
 * rows merge into one bar, which is dropped when it is taller than `maxHeight` (flames, roofs and
 * other red shapes are tall or ragged). Returns bars in screen pixels, widest (usually nearest)
 * first. `scale` converts the reference-pixel sizes to this screen.
 */
export function enemyBars(image, bounds, screen, enemy, scale = 1, step = 2, shapes = false) {
  const sx = image.width / screen.width,
    sy = image.height / screen.height;
  const { rgb, tolerance } = enemy;
  const minWidth = (enemy.minWidth ?? 16) * scale,
    maxHeight = (enemy.maxHeight ?? 12) * scale;
  const match = (x, y) => {
    const p = rgbAt(image, x, y);
    return (
      Math.abs(p[0] - rgb[0]) <= tolerance &&
      Math.abs(p[1] - rgb[1]) <= tolerance &&
      Math.abs(p[2] - rgb[2]) <= tolerance
    );
  };
  const left = Math.round(bounds.left * sx),
    right = Math.round(bounds.right * sx);
  const blobs = [];
  for (let y = Math.round(bounds.top * sy); y < Math.round(bounds.bottom * sy); y += step) {
    let start = -1,
      end = -1;
    const flush = () => {
      // Short runs are kept too, so slanted red shapes join into one (tall) blob and drop out.
      if (start >= 0 && end - start >= step * 2) {
        const blob = blobs.find(
          (b) => y - b.bottom <= step * 2 && start <= b.right && end >= b.left,
        );
        if (blob) {
          blob.left = Math.min(blob.left, start);
          blob.right = Math.max(blob.right, end);
          blob.bottom = y;
          blob.rows.push([y, start, end]);
        } else blobs.push({ left: start, right: end, top: y, bottom: y, rows: [[y, start, end]] });
      }
      start = -1;
    };
    for (let x = left; x < right; x += step) {
      if (match(x, y)) {
        if (start < 0 || x - end > step * 2) {
          flush();
          start = x;
        }
        end = x;
      }
    }
    flush();
  }
  // Pieces of one red shape that touch (the off-screen enemy arrow splits into slanted pieces)
  // are merged first, so the height and shape checks see the whole shape.
  for (let merged = true; merged && blobs.length <= 400; ) {
    merged = false;
    for (let i = 0; i < blobs.length; i++)
      for (let j = blobs.length - 1; j > i; j--) {
        const a = blobs[i],
          b = blobs[j];
        const gap = step * 2;
        if (
          a.left - gap <= b.right &&
          b.left - gap <= a.right &&
          a.top - gap <= b.bottom &&
          b.top - gap <= a.bottom
        ) {
          a.left = Math.min(a.left, b.left);
          a.right = Math.max(a.right, b.right);
          a.top = Math.min(a.top, b.top);
          a.bottom = Math.max(a.bottom, b.bottom);
          a.rows.push(...b.rows);
          blobs.splice(j, 1);
          merged = true;
        }
      }
  }
  // An HP bar is a rectangle: most rows span nearly its full width. Arrows and slanted shapes do not.
  const rectangular = (b) => {
    const extent = new Map();
    for (const [y, s, e] of b.rows) {
      const [l, r] = extent.get(y) ?? [s, e];
      extent.set(y, [Math.min(l, s), Math.max(r, e)]);
    }
    const full = (b.right - b.left) * 0.75;
    let wide = 0;
    for (const [l, r] of extent.values()) if (r - l >= full) wide++;
    return wide >= extent.size / 2;
  };
  const box = (b) => ({
    x: Math.round((b.left + b.right) / 2 / sx),
    y: Math.round((b.top + b.bottom) / 2 / sy),
    w: Math.round((b.right - b.left + step) / sx),
    h: Math.round((b.bottom - b.top + step) / sy),
  });
  const isBar = (b) =>
    (b.right - b.left + step) / sx >= minWidth &&
    (b.bottom - b.top + step) / sy <= maxHeight &&
    rectangular(b);
  // Callers looking for other red marks (the off-screen enemy arrow) ask for the rejected shapes.
  if (shapes) return blobs.filter((b) => !isBar(b)).map(box);
  return blobs
    .filter(isBar)
    .map(box)
    .sort((a, b) => b.w - a.w);
}

/**
 * Genshin's off-screen enemy arrow: a red chevron on a ring around the screen centre pointing
 * towards an enemy that attacks from outside the view. Returns the camera turn towards it
 * (degrees, positive = counter-clockwise like `dragCamera`) or null. `ring` is
 * `{ x, y, inner, outer }` in reference px about the screen centre.
 */
export function enemyArrow(image, screen, enemy, scale = 1) {
  const ring = enemy.arrowRing;
  if (!ring) return null;
  const cx = screen.width / 2 + (ring.dx ?? 0) * scale,
    cy = screen.height / 2 + (ring.dy ?? 0) * scale;
  const outer = ring.outer * scale,
    inner = ring.inner * scale;
  const bounds = {
    left: Math.max(0, cx - outer),
    top: Math.max(0, cy - outer),
    right: Math.min(screen.width, cx + outer),
    bottom: Math.min(screen.height, cy + outer),
  };
  const min = (ring.minSize ?? 18) * scale,
    max = (ring.maxSize ?? 90) * scale;
  const arrows = enemyBars(image, bounds, screen, enemy, scale, 2, true).filter((s) => {
    const r = Math.hypot(s.x - cx, s.y - cy);
    return r >= inner && r <= outer && s.w >= min && s.h >= min && s.w <= max && s.h <= max;
  });
  if (!arrows.length) return null;
  const [a] = arrows.sort((p, q) => q.w * q.h - p.w * p.h);
  // Screen angle of the arrow (90 = straight ahead): turning by (angle - 90) faces it.
  const angle = (Math.atan2(-(a.y - cy), a.x - cx) * 180) / Math.PI;
  return { deg: wrapDeg(angle - 90), x: a.x, y: a.y };
}

/**
 * Candidate enemy level labels (Genshin draws "Lv.13" above enemies too far away for an HP bar):
 * small clusters of light grey text pixels inside `bounds` with a dark backdrop around them.
 * Grass highlights and white armour also match, so callers confirm each candidate with OCR.
 * Sizes are device px at `scale` 1. Returns boxes in screen pixels.
 */
export function labelCandidates(image, bounds, screen, scale = 1) {
  const sx = image.width / screen.width,
    sy = image.height / screen.height;
  const C = 3;
  const left = Math.round(bounds.left * sx),
    top = Math.round(bounds.top * sy);
  const W = Math.ceil((Math.round(bounds.right * sx) - left) / C),
    H = Math.ceil((Math.round(bounds.bottom * sy) - top) / C);
  const cell = new Uint16Array(W * H);
  for (let y = top; y < top + H * C && y < image.height; y++)
    for (let x = left; x < left + W * C && x < image.width; x++) {
      const [r, g, b] = rgbAt(image, x, y);
      const mn = Math.min(r, g, b);
      if (mn >= 175 && Math.max(r, g, b) - mn <= 50)
        cell[Math.floor((y - top) / C) * W + Math.floor((x - left) / C)]++;
    }
  const k = sx * scale;
  const seen = new Uint8Array(W * H);
  const out = [];
  const maxOf = (x, y) => Math.max(...rgbAt(image, x, y));
  for (let i = 0; i < W * H; i++) {
    if (!cell[i] || seen[i]) continue;
    const stack = [i];
    seen[i] = 1;
    let x0 = W,
      x1 = -1,
      y0 = H,
      y1 = -1,
      n = 0;
    while (stack.length) {
      const j = stack.pop();
      const cx = j % W,
        cy = (j - cx) / W;
      n += cell[j];
      x0 = Math.min(x0, cx);
      x1 = Math.max(x1, cx);
      y0 = Math.min(y0, cy);
      y1 = Math.max(y1, cy);
      // Letters sit up to two cells apart horizontally, one vertically.
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          const nx = cx + dx,
            ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const m = ny * W + nx;
          if (cell[m] && !seen[m]) {
            seen[m] = 1;
            stack.push(m);
          }
        }
    }
    const w = (x1 - x0 + 1) * C,
      h = (y1 - y0 + 1) * C;
    if (w < 24 * k || w > 72 * k || h < 7 * k || h > 18 * k) continue;
    const fill = n / (w * h);
    if (fill < 0.08 || fill > 0.4) continue;
    const L = left + x0 * C,
      T = top + y0 * C;
    const x2 = Math.min(image.width - 1, L + w + 3),
      y2 = Math.min(image.height - 1, T + h + 2);
    const xa = Math.max(0, L - 4),
      ya = Math.max(0, T - 3);
    const ring = [];
    for (let x = xa; x <= x2; x++) ring.push(maxOf(x, ya), maxOf(x, y2));
    for (let y = T; y < T + h; y++) ring.push(maxOf(xa, y), maxOf(x2, y));
    if (ring.reduce((a, b) => a + b, 0) / ring.length > 120) continue;
    out.push({
      left: Math.round((L - 8) / sx),
      top: Math.round((T - 4) / sy),
      right: Math.round((L + w + 8) / sx),
      bottom: Math.round((T + h + 4) / sy),
    });
  }
  return out;
}

/**
 * Enemies on a frame: HP bars first; if none and the detector has a `label` pattern and OCR is
 * available (`readText(image, box)` in image px), OCR-confirmed level labels as far targets.
 * Returns `{ bars, labels }` with labels as `{x, y, w, h, far: true}` in screen px.
 */
export async function findEnemies(image, screen, enemy, readText) {
  const bars = enemyBars(image, enemy.bounds, screen, enemy, enemy.scale);
  if (bars.length || !enemy.levelText || !readText) return { bars, labels: [] };
  const pattern = new RegExp(enemy.levelText);
  const sx = image.width / screen.width,
    sy = image.height / screen.height;
  const labels = [];
  for (const box of labelCandidates(image, enemy.bounds, screen, enemy.scale).slice(0, 6)) {
    const text = await readText(image, {
      left: Math.max(0, Math.round(box.left * sx)),
      top: Math.max(0, Math.round(box.top * sy)),
      right: Math.min(image.width, Math.round(box.right * sx)),
      bottom: Math.min(image.height, Math.round(box.bottom * sy)),
    });
    if (text && pattern.test(text))
      labels.push({
        x: Math.round((box.left + box.right) / 2),
        y: Math.round((box.top + box.bottom) / 2),
        w: box.right - box.left,
        h: box.bottom - box.top,
        far: true,
        text,
      });
  }
  // The label lowest on the screen is usually the closest enemy.
  labels.sort((a, b) => b.y - a.y);
  return { bars, labels };
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
 * Whether a teammate row shows a colour portrait: at least `minPixels` pixels whose channel
 * spread (max − min) reaches `minSaturation` in the `w`×`h` box at (`dx`, `dy`) from the row's
 * button centre (reference px at `scale`). Downed teammates show a grey portrait; HP bar colour
 * is no use because a living teammate's bar turns red when low.
 */
export function teammateUp(image, screen, center, alive, scale = 1) {
  const sx = image.width / screen.width,
    sy = image.height / screen.height;
  const cx = center.x + (alive.dx ?? 0) * scale,
    cy = center.y + (alive.dy ?? 0) * scale;
  const hw = (alive.w * scale) / 2,
    hh = (alive.h * scale) / 2;
  const spread = alive.minSaturation ?? 70,
    need = alive.minPixels ?? 100;
  let hits = 0;
  const top = Math.max(0, Math.round((cy - hh) * sy)),
    bottom = Math.min(image.height, Math.round((cy + hh) * sy));
  const left = Math.max(0, Math.round((cx - hw) * sx)),
    right = Math.min(image.width, Math.round((cx + hw) * sx));
  for (let y = top; y < bottom; y++)
    for (let x = left; x < right; x++) {
      const [r, g, b] = rgbAt(image, x, y);
      if (Math.max(r, g, b) - Math.min(r, g, b) >= spread && ++hits >= need) return true;
    }
  return false;
}

/**
 * Fight with a fixed rotation: skill, burst, `attackTaps` attacks, then switch to the next
 * teammate row (rows 1, 2, 3 in turn visit every party member even though the list shifts).
 * With a layout `enemy` HP bar detector it always fights one round first (attacks turn towards
 * nearby enemies and wake their HP bars), then stops with `no_enemy` if no bar ever appeared,
 * or `clear` after `clearFrames` frames without one once it had appeared; otherwise it fights
 * until maxMs. It stops with `interrupted` when the screen leaves the allowed set.
 */
export async function combat(ctx) {
  const { routine, screen, frame, sleep, now, enemy } = ctx;
  const { counts, started, result } = tracker(routine, now);
  Object.assign(counts, { rounds: 0, switches: 0, downed: 0, recoveries: 0, enemy: [] });
  const maxMs = routine.maxMs ?? 30_000;
  const allowed = new Set(routine.screens);
  const recover = routine.recover ?? {};
  const switches = routine.switchButtons ?? [];
  let row = 0;
  let current = await frame();
  let unknown = 0,
    still = 0,
    clear = 0,
    engaged = false;
  for (;;) {
    if (recover[current.screen] && counts.recoveries < (routine.recoverLimit ?? 3)) {
      // e.g. a revive dialog opened by switching to a downed teammate: close it and fight on.
      await tapButton(ctx, recover[current.screen]);
      counts.recoveries++;
      await sleep(routine.recoverMs ?? 600);
      current = await frame();
      counts.frames++;
      continue;
    }
    if (current.screen === null) {
      if (++unknown >= 2) return result('interrupted', { screen: 'unknown' });
    } else if (!allowed.has(current.screen)) {
      return result('interrupted', { screen: current.screen });
    } else {
      unknown = 0;
      if (enemy) {
        const seen = enemyBars(current.image, enemy.bounds, screen, enemy, enemy.scale).length;
        counts.enemy.push(seen);
        if (seen > 0) {
          engaged = true;
          clear = 0;
        } else if (counts.rounds >= 1 && !engaged) {
          return result('no_enemy', { screen: current.screen });
        } else if (engaged && ++clear >= (routine.clearFrames ?? 2)) {
          return result('clear', { screen: current.screen });
        }
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
      // Rows 1, 2, 3 in turn; skip rows whose HP bar is not showing (a downed teammate).
      for (let tried = 0; tried < switches.length; tried++) {
        const id = switches[row++ % switches.length];
        const alive = routine.alivePortrait;
        if (
          alive &&
          !teammateUp(current.image, screen, ctx.buttonCenter(id), alive, ctx.hudScale)
        ) {
          counts.downed++;
          continue;
        }
        await tapButton(ctx, id);
        counts.switches++;
        await sleep(routine.switchMs ?? 300);
        break;
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

const wrapDeg = (deg) => ((((deg + 180) % 360) + 360) % 360) - 180;
const angleOf = (dx, dy) => (Math.atan2(-dy, dx) * 180) / Math.PI;

// Turn the camera by `deg` (positive = the sign convention of the minimap, counter-clockwise)
// with one horizontal drag, clamped to `camera.maxDrag`.
async function dragCamera(camera, touch, deg) {
  const dx = Math.max(
    -camera.maxDrag,
    Math.min(
      camera.maxDrag,
      -Math.sign(deg) * (Math.abs(deg) / camera.degreesPerPixel + camera.deadzone),
    ),
  );
  const steps = 8;
  await touch('down', camera.x, camera.y);
  for (let i = 1; i <= steps; i++)
    await touch('move', Math.round(camera.x + (dx * i) / steps), camera.y);
  await touch('up', Math.round(camera.x + dx), camera.y);
}

/**
 * Where a coloured marker sits on a round minimap: the centroid of pixels within `tolerance` of
 * `rgb`, or (since the icon is semi-transparent and blends with the terrain under it, shifting
 * its brightness) within the `min`–`max` channel range if given, up to `reach` times the minimap
 * half-width from its centre. `deg` is the compass-style screen angle (0 = right, 90 = up), `r`
 * the distance as a fraction of the half-width.
 */
export function markerBearing(image, screen, minimap, marker, reach) {
  const { rgb, tolerance, min, max, minPixels = 4 } = marker;
  const matches = (p) =>
    (rgb && p.every((v, i) => Math.abs(v - rgb[i]) <= tolerance)) ||
    (min && max && p.every((v, i) => v >= min[i] && v <= max[i]));
  const sx = image.width / screen.width,
    sy = image.height / screen.height;
  const cx = (minimap.left + minimap.right) / 2,
    cy = (minimap.top + minimap.bottom) / 2,
    half = (minimap.right - minimap.left) / 2,
    max_ = half * reach;
  let x0 = 0,
    y0 = 0,
    n = 0;
  for (
    let y = Math.max(0, Math.round(cy - max_));
    y <= Math.min(screen.height - 1, cy + max_);
    y += 2
  )
    for (
      let x = Math.max(0, Math.round(cx - max_));
      x <= Math.min(screen.width - 1, cx + max_);
      x += 2
    ) {
      if (Math.hypot(x - cx, y - cy) > max_) continue;
      const p = rgbAt(image, Math.floor(x * sx), Math.floor(y * sy));
      if (!matches(p)) continue;
      x0 += x;
      y0 += y;
      n++;
    }
  if (n < minPixels) return null;
  const dx = x0 / n - cx,
    dy = y0 / n - cy;
  return { deg: angleOf(dx, dy), r: Math.hypot(dx, dy) / half, pixels: n };
}

/**
 * Camera heading from the translucent view cone drawn over the minimap: the `width`-degree
 * window of a ring (`ring` fractions of the half-width) that is brightest against the ring
 * beside it. `contrast` is that brightness difference; a low value means no visible cone.
 */
export function coneHeading(image, screen, minimap, { ring = [0.33, 0.94], width = 85 } = {}) {
  const sx = image.width / screen.width,
    sy = image.height / screen.height;
  const cx = (minimap.left + minimap.right) / 2,
    cy = (minimap.top + minimap.bottom) / 2,
    half = (minimap.right - minimap.left) / 2;
  const bins = 72,
    sum = new Array(bins).fill(0),
    count = new Array(bins).fill(0);
  const [inner, outer] = ring.map((f) => f * half);
  for (let y = Math.round(cy - outer); y <= cy + outer; y += 2)
    for (let x = Math.round(cx - outer); x <= cx + outer; x += 2) {
      const r = Math.hypot(x - cx, y - cy);
      if (r < inner || r > outer || x < 0 || y < 0) continue;
      const [R, G, B] = rgbAt(image, Math.floor(x * sx), Math.floor(y * sy));
      const b = ((Math.floor(angleOf(x - cx, y - cy) / (360 / bins)) % bins) + bins) % bins;
      sum[b] += (R + G + B) / 3;
      count[b]++;
    }
  const lum = sum.map((s, i) => (count[i] ? s / count[i] : 0));
  const k = Math.round(width / 2 / (360 / bins));
  let best = 0,
    contrast = -Infinity;
  for (let b = 0; b < bins; b++) {
    let inside = 0,
      beside = 0;
    for (let i = -k; i <= k; i++) inside += lum[(b + i + bins) % bins];
    for (let i = k + 2; i <= 3 * k + 2; i++)
      beside += lum[(b + i) % bins] + lum[(b - i + 2 * bins) % bins];
    const c = inside / (2 * k + 1) - beside / (2 * (2 * k + 1));
    if (c > contrast) {
      contrast = c;
      best = b;
    }
  }
  return { deg: wrapDeg((best + 0.5) * (360 / bins)), contrast };
}

/**
 * Head for the tracked quest marker on the minimap. The joystick moves relative to the camera
 * and the camera turns while strafing, so the routine turns the camera (a horizontal drag on
 * `camera`) until the view cone points at the marker, then runs forward, re-aiming after every
 * frame. Once the marker is inside the minimap it walks in short hops so it does not overrun it.
 * On a `recover`-mapped screen (e.g. climbing a wall) it keeps holding forward as long as the
 * full-frame view keeps changing (real progress), and only drops and turns away after
 * `recoverAfter` consecutive frames without visible change (a genuine stall), instead of
 * abandoning a climb just for taking a while.
 * Ends with `arrived` when the marker reaches the centre, `found` on a stop screen, `no_marker`
 * without one, `no_camera` when the cone cannot be seen, `stuck`, `interrupted` or `timeout`;
 * `moved` reports progress.
 */
export async function navigate(ctx) {
  const { routine, joystick, minimap, camera, screen, frame, touch, sleep, now } = ctx;
  const { counts, started, result: finish } = tracker(routine, now);
  Object.assign(counts, { drags: 0, segments: 0, stuck: 0, recoveries: 0, motion: [] });
  const maxMs = routine.maxMs ?? 30_000;
  const threshold = routine.motionThreshold ?? 1.5;
  const stuckLimit = routine.stuckLimit ?? 3;
  const allowed = new Set(routine.screens);
  const result = (status, extra) =>
    finish(status, { moved: counts.motion.some((m) => m >= threshold), ...extra });
  let held = null;
  const release = async () => {
    if (!held) return;
    const [x, y] = held;
    held = null;
    await touch('up', x, y);
  };
  const press = async (deflection) => {
    const point = [joystick.x, Math.round(joystick.y - joystick.radius * deflection)];
    if (!held) await touch('down', joystick.x, joystick.y);
    await touch('move', ...point);
    held = point;
  };
  const turnCamera = async (deg) => {
    await release();
    await dragCamera(camera, touch, deg);
    counts.drags++;
    turned = true;
    await sleep(routine.dragSettleMs ?? 300);
  };
  const tapButton = async (id) => {
    await release();
    const { x, y } = ctx.buttonCenter(id);
    await touch('down', x, y);
    await touch('up', x, y);
  };
  const markerColor = routine.marker;
  const fullScreen = { left: 0, top: 0, right: screen.width, bottom: screen.height };
  let current = await frame();
  let unknown = 0,
    recovering = 0,
    turned = false,
    climbImage = null;
  try {
    for (;;) {
      if (current.screen === null) {
        await release();
        if (++unknown >= 2) return result('interrupted', { screen: 'unknown' });
      } else {
        unknown = 0;
        const recover = routine.recover?.[current.screen];
        if (recover) {
          // Only treat climbing as a stuck obstacle once the view stops changing (no real
          // progress), not just for being on the climbing screen for a while: a genuine climb
          // can take many frames and must not be abandoned mid-way.
          const moving = climbImage
            ? regionMotion(climbImage, current.image, fullScreen, screen) >=
              (routine.climbMotionThreshold ?? threshold)
            : true;
          climbImage = current.image;
          if (moving) recovering = 0;
          if (!held) await press(routine.deflection ?? 1);
          if (!moving && ++recovering >= (routine.recoverAfter ?? 1)) {
            // Climbing into an obstacle: drop, then try to walk around it at an angle.
            recovering = 0;
            counts.recoveries++;
            if (++counts.stuck >= stuckLimit) return result('stuck', { screen: current.screen });
            await tapButton(recover);
            await sleep(routine.recoverMs ?? 800);
            await turnCamera(counts.stuck % 2 ? 70 : -70);
          }
        } else {
          recovering = 0;
          climbImage = null;
          if (!allowed.has(current.screen))
            return result('interrupted', { screen: current.screen });
          if (counts.segments > 0 && routine.stopScreens?.includes(current.screen))
            return result('found', { screen: current.screen });
          const marker = markerBearing(
            current.image,
            screen,
            minimap,
            markerColor,
            routine.markerReach ?? 1.35,
          );
          if (!marker) return result('no_marker', { screen: current.screen });
          if (marker.r <= (routine.arriveRadius ?? 0.12))
            return result('arrived', { screen: current.screen, marker });
          const cone = coneHeading(current.image, screen, minimap, routine.cone);
          if (cone.contrast < (routine.cone?.minContrast ?? 12))
            return result('no_camera', {
              screen: current.screen,
              contrast: Math.round(cone.contrast),
            });
          const error = wrapDeg(marker.deg - cone.deg);
          if (Math.abs(error) > (routine.turnDeg ?? 20)) await turnCamera(error);
          counts.segments++;
          if (marker.r < (routine.nearRadius ?? 1.1)) {
            // Close: walk a short hop and stop, so the marker is not overrun between frames.
            await press(routine.nearDeflection ?? 0.5);
            await sleep(routine.hopMs ?? 700);
            await release();
          } else {
            await press(routine.deflection ?? 1);
            if (routine.segmentMs) await sleep(routine.segmentMs);
          }
        }
      }
      if (now() - started >= maxMs)
        return result('timeout', { screen: current.screen ?? 'unknown' });
      const next = await frame();
      counts.frames++;
      // A camera turn redraws the minimap cone, so motion only counts for frames without one.
      const skip = turned;
      turned = false;
      if (
        !skip &&
        next.screen !== null &&
        current.screen !== null &&
        !routine.recover?.[next.screen]
      ) {
        const motion = regionMotion(current.image, next.image, minimap, screen);
        counts.motion.push(Math.round(motion * 10) / 10);
        if (motion < threshold) {
          if (++counts.stuck >= stuckLimit) return result('stuck', { screen: next.screen });
          if (routine.stuckButton) await tapButton(routine.stuckButton);
          await turnCamera(counts.stuck % 2 ? 60 : -60);
          await press(routine.deflection ?? 1);
          await sleep(routine.hopMs ?? 700);
        }
      }
      current = next;
    }
  } finally {
    await release();
  }
}

/**
 * Walk towards the nearest visible enemy HP bar (the widest one) or, with none visible, an
 * OCR-confirmed enemy level label (`enemy.levelText`, walking `farHopMs` per hop). Each step turns the camera
 * so the bar is roughly centred (`viewDegreesPerPixel`, reference px) and walks one forward hop,
 * then checks again standing still. Ends with `near` once the bar is at least `enemy.nearWidth`
 * wide (close enough to fight), `no_enemy` if none is visible at the start (after turning the
 * camera by `scanDeg` up to `scanSteps` times to look around), `lost` after
 * `lostLimit` frames without a bar, `stuck` when the minimap stops moving, `interrupted` or
 * `timeout`.
 */
export async function approach(ctx) {
  const { routine, joystick, minimap, camera, screen, frame, touch, sleep, now, enemy } = ctx;
  const { counts, started, result: finish } = tracker(routine, now);
  Object.assign(counts, {
    hops: 0,
    drags: 0,
    scans: 0,
    arrows: 0,
    stuck: 0,
    widths: [],
    labels: 0,
  });
  const maxMs = routine.maxMs ?? 20_000;
  const threshold = routine.motionThreshold ?? 1.5;
  const allowed = new Set(routine.screens);
  const result = (status, extra) => finish(status, { moved: counts.hops > counts.stuck, ...extra });
  const degPerPx = routine.viewDegreesPerPixel / enemy.scale;
  const nearWidth = enemy.nearWidth * enemy.scale;
  let pressed = null;
  const release = async () => {
    if (!pressed) return;
    const [x, y] = pressed;
    pressed = null;
    await touch('up', x, y);
  };
  let current = await frame();
  let unknown = 0,
    lost = 0,
    seen = false,
    far = false;
  try {
    for (;;) {
      if (current.screen === null) {
        if (++unknown >= 2) return result('interrupted', { screen: 'unknown' });
      } else {
        unknown = 0;
        if (!allowed.has(current.screen)) return result('interrupted', { screen: current.screen });
        const found = await findEnemies(current.image, screen, enemy, ctx.readText);
        const nearest = found.bars[0] ?? found.labels[0];
        far = !found.bars.length && Boolean(nearest);
        if (far) counts.labels++;
        if (!nearest) {
          // An enemy attacking from outside the view: face its arrow and walk a hop towards it
          // (the arrow can stay up after turning when the enemy is hidden or right behind us).
          const arrow = !seen && enemyArrow(current.image, screen, enemy, enemy.scale);
          if (arrow && counts.arrows < (routine.arrowTurns ?? 3)) {
            await dragCamera(camera, touch, arrow.deg);
            counts.arrows++;
            counts.drags++;
            await sleep(routine.dragSettleMs ?? 300);
          } else if (!seen && counts.scans < (routine.scanSteps ?? 0)) {
            // Look around before giving up: turn the camera in place, up to a full circle.
            await dragCamera(camera, touch, routine.scanDeg ?? 60);
            counts.scans++;
            counts.drags++;
            await sleep(routine.dragSettleMs ?? 300);
            current = await frame();
            counts.frames++;
            if (now() - started >= maxMs)
              return result('timeout', { screen: current.screen ?? 'unknown' });
            continue;
          } else if (!seen) {
            // Finish the circle so the character faces where it started (explore walks on).
            const rest = wrapDeg(360 - counts.scans * (routine.scanDeg ?? 60));
            if (counts.scans && Math.abs(rest) >= 1) {
              await dragCamera(camera, touch, rest);
              counts.drags++;
            }
            return result('no_enemy', { screen: current.screen });
          } else if (++lost >= (routine.lostLimit ?? 3))
            return result('lost', { screen: current.screen });
        } else {
          seen = true;
          lost = 0;
          if (!far) counts.widths.push(nearest.w);
          if (!far && nearest.w >= nearWidth)
            return result('near', { screen: current.screen, bar: nearest });
          const deg = -(nearest.x - screen.width / 2) * degPerPx;
          if (Math.abs(deg) > (routine.turnDeg ?? 10)) {
            await dragCamera(camera, touch, deg);
            counts.drags++;
            await sleep(routine.dragSettleMs ?? 300);
          }
        }
      }
      if (now() - started >= maxMs)
        return result('timeout', { screen: current.screen ?? 'unknown' });
      // One forward hop, then look again at rest (bars flicker while running).
      await touch('down', joystick.x, joystick.y);
      pressed = [joystick.x, joystick.y];
      const point = [joystick.x, Math.round(joystick.y - joystick.radius)];
      await touch('move', ...point);
      pressed = point;
      // A level label means the enemy is still far away: walk longer before looking again.
      await sleep(far ? (routine.farHopMs ?? routine.hopMs ?? 800) : (routine.hopMs ?? 800));
      await release();
      counts.hops++;
      const next = await frame();
      counts.frames++;
      if (next.screen !== null && current.screen !== null) {
        const motion = regionMotion(current.image, next.image, minimap, screen);
        if (motion < threshold) {
          if (++counts.stuck >= (routine.stuckLimit ?? 3))
            return result('stuck', { screen: next.screen });
          if (routine.stuckButton) await tapButton(ctx, routine.stuckButton);
        }
      }
      current = next;
    }
  } finally {
    await release();
  }
}

const near = (rgb, tolerance) => {
  const t = Array.isArray(tolerance) ? tolerance : [tolerance, tolerance, tolerance];
  return (p) =>
    Math.abs(p[0] - rgb[0]) <= t[0] &&
    Math.abs(p[1] - rgb[1]) <= t[1] &&
    Math.abs(p[2] - rgb[2]) <= t[2];
};
const inside = (p, b) => p.x >= b.left && p.x < b.right && p.y >= b.top && p.y < b.bottom;
const within = (value, [min, max], scale = 1) => value >= min * scale && value <= max * scale;

/**
 * 4-connected blobs of pixels matching `match` (image px, full frame), returned in screen px as
 * `{x, y, n, w, h}` (centre, pixel count and bounding box in image px).
 */
export function colorBlobs(image, screen, match) {
  const { width: W, height: H } = image;
  const seen = new Uint8Array(W * H);
  const blobs = [];
  const stack = [];
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const start = y * W + x;
      if (seen[start] || !match(rgbAt(image, x, y))) continue;
      seen[start] = 1;
      stack.push(start);
      let n = 0,
        sumX = 0,
        sumY = 0,
        left = x,
        right = x,
        top = y,
        bottom = y;
      while (stack.length) {
        const i = stack.pop();
        const px = i % W,
          py = (i - px) / W;
        n++;
        sumX += px;
        sumY += py;
        if (px < left) left = px;
        if (px > right) right = px;
        if (py < top) top = py;
        if (py > bottom) bottom = py;
        for (const [qx, qy] of [
          [px + 1, py],
          [px - 1, py],
          [px, py + 1],
          [px, py - 1],
        ]) {
          if (qx < 0 || qy < 0 || qx >= W || qy >= H) continue;
          const k = qy * W + qx;
          if (seen[k] || !match(rgbAt(image, qx, qy))) continue;
          seen[k] = 1;
          stack.push(k);
        }
      }
      blobs.push({
        x: Math.round(((sumX / n) * screen.width) / W),
        y: Math.round(((sumY / n) * screen.height) / H),
        n,
        w: right - left + 1,
        h: bottom - top + 1,
      });
    }
  return blobs;
}

/**
 * Tracked-quest diamonds on the world map: blobs of `quest.rgb` with `quest.pixels` pixels and a
 * near-square `quest.size` box (reference px at `scale`), outside the `exclude` screen rects
 * (e.g. the recommended-quest banner, whose diamond looks the same).
 */
export function mapQuestMarkers(image, screen, quest, exclude = [], scale = 1) {
  const area = scale * scale;
  return colorBlobs(image, screen, near(quest.rgb, quest.tolerance)).filter(
    (b) =>
      within(b.n, quest.pixels, area) &&
      within(b.w, quest.size, scale) &&
      within(b.h, quest.size, scale) &&
      !exclude.some((rect) => inside(b, rect)),
  );
}

/**
 * Unlocked teleport points on the world map: blobs of `waypoint.rgb` matching one of the
 * `waypoint.shapes` (pixel count and box per icon kind: waypoint diamond, Statue of the Seven)
 * with at least `ring.min` white pixels (all channels above `ring.white`) on a circle of
 * `ring.radius` around them: the white pin outline that locked (grey) points lack.
 */
export function mapWaypoints(image, screen, waypoint, exclude = [], scale = 1) {
  const sx = image.width / screen.width,
    sy = image.height / screen.height;
  const area = scale * scale;
  const { radius, white, min } = waypoint.ring;
  const ringWhite = (b) => {
    let count = 0;
    for (let k = 0; k < 16; k++) {
      const a = (k * Math.PI) / 8;
      const x = Math.round((b.x + radius * scale * Math.cos(a)) * sx),
        y = Math.round((b.y + radius * scale * Math.sin(a)) * sy);
      if (x < 0 || y < 0 || x >= image.width || y >= image.height) continue;
      if (rgbAt(image, x, y).every((v) => v > white)) count++;
    }
    return count;
  };
  return colorBlobs(image, screen, near(waypoint.rgb, waypoint.tolerance)).filter(
    (b) =>
      waypoint.shapes.some(
        (s) => within(b.n, s.pixels, area) && within(b.w, s.w, scale) && within(b.h, s.h, scale),
      ) &&
      !exclude.some((rect) => inside(b, rect)) &&
      ringWhite(b) >= min,
  );
}

/**
 * Teleport to the unlocked teleport point nearest the tracked quest. From the open world it taps
 * `open` (the minimap) to open the world map; there the quest's edge indicator is tapped so the
 * map centres on the quest, the nearest unlocked point is tapped, and an OCR-confirmed teleport
 * panel (`title` matches `targetText`, `button` reads `buttonText`) gets one tap on its button;
 * an overlap list (`list`) is resolved by OCR first. 传送 is tapped at most once: when the world
 * does not come back in time the result is `timeout`, never a second tap. On failure the map is
 * left open (Jev sees `world_map` and can press BACK).
 */
export async function teleport(ctx) {
  const { routine, screen, frame, sleep, now, readText } = ctx;
  const { counts, started, result } = tracker(routine, now);
  counts.taps = 0;
  if (!readText) return result('no_ocr');
  const scale = ctx.hudScale ?? 1;
  const maxMs = routine.maxMs ?? 30_000;
  const settle = routine.tapSettleMs ?? 800;
  const mapScreen = routine.mapScreen ?? 'world_map';
  const done = new Set(routine.doneScreens ?? []);
  const exclude = (routine.exclude ?? []).map((rect) => ctx.rect(rect)).filter(Boolean);
  const box = (image, rect) => {
    const b = ctx.rect(rect);
    const sx = image.width / screen.width,
      sy = image.height / screen.height;
    return {
      left: Math.round(b.left * sx),
      top: Math.round(b.top * sy),
      right: Math.round(b.right * sx),
      bottom: Math.round(b.bottom * sy),
    };
  };
  const tap = async (x, y) => {
    await ctx.touch('down', Math.round(x), Math.round(y));
    await ctx.touch('up', Math.round(x), Math.round(y));
    counts.taps++;
  };
  const next = async (ms = settle) => {
    await sleep(ms);
    counts.frames++;
    return frame();
  };
  const center = { x: screen.width / 2, y: screen.height / 2 };
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const reach = (routine.centerRadius ?? 40) * scale;

  let current = await frame();
  const world = current.screen !== mapScreen ? current : null;
  if (world) {
    if (!routine.screens.includes(current.screen))
      return result('interrupted', { screen: current.screen ?? 'unknown' });
    // The HUD's quest distance is cheapest: a close quest is walked to, not teleported to. Near
    // the quest the map shows an area instead of a diamond, so the map check below cannot see it.
    if (routine.distance && routine.nearMeters) {
      const metres = Number(
        (await readText(current.image, box(current.image, routine.distance))).match(
          /(\d+)\s*m/i,
        )?.[1],
      );
      if (metres <= routine.nearMeters)
        return result('quest_near', { screen: current.screen, questMetres: metres, closed: true });
    }
    await tapButton(ctx, routine.open);
    counts.taps++;
    current = await next(routine.openMs ?? 1500);
    if (current.screen !== mapScreen)
      return result('no_map', { screen: current.screen ?? 'unknown' });
    // A freshly opened map is centred on the player: a quest diamond near the centre is close
    // enough to walk, so close the map and leave the walking to navigate.
    if (routine.nearRadius) {
      const near = mapQuestMarkers(current.image, screen, routine.quest, exclude, scale)
        .map((m) => ({ ...m, d: dist(m, center) }))
        .filter((m) => m.d <= routine.nearRadius * scale)
        .sort((a, b) => a.d - b.d)[0];
      if (near) {
        let closed = false;
        if (ctx.back) {
          await ctx.back();
          current = await next();
          closed = current.screen !== mapScreen;
        }
        return result('quest_near', {
          screen: current.screen ?? 'unknown',
          questDistance: Math.round(near.d),
          closed,
        });
      }
    }
  }

  // Tapping the quest's edge indicator centres the map on it. A diamond already on the map may
  // instead open a list or panel without moving the map: then the tapped spot is the quest.
  const centred = (image) =>
    mapQuestMarkers(image, screen, routine.quest, exclude, scale).find(
      (m) => dist(m, center) <= reach,
    );
  let quest = centred(current.image),
    mapImage = current.image,
    overlay = false;
  if (!quest) {
    const markers = mapQuestMarkers(current.image, screen, routine.quest, exclude, scale).sort(
      (a, b) => dist(b, center) - dist(a, center),
    );
    if (!markers.length) return result('no_quest', { screen: mapScreen });
    await tap(markers[0].x, markers[0].y);
    const before = current;
    current = await next();
    if (current.screen !== mapScreen)
      return result('interrupted', { screen: current.screen ?? 'unknown' });
    quest = centred(current.image);
    if (quest) mapImage = current.image;
    else {
      quest = markers[0];
      mapImage = before.image;
      overlay = true;
    }
  }

  const target = new RegExp(routine.targetText ?? '传送锚点|七天神像');
  const buttonText = routine.buttonText ?? '传送';
  const panel = routine.panel && ctx.rect(routine.panel);
  const confirm = async (image) => (await readText(image, box(image, routine.button))).trim();
  // Overlapping icons open a list first; tap the middle of the rows that read a teleport point.
  const pickFromList = async () => {
    if (!routine.list) return false;
    const list = ctx.rect(routine.list);
    const rowH = (routine.list.rowH ?? 56) * scale;
    const sx = current.image.width / screen.width,
      sy = current.image.height / screen.height;
    const hits = [];
    for (let y = list.top; y + rowH <= list.bottom; y += rowH / 2) {
      if (hits.length && y - hits.at(-1) > rowH / 2) break;
      const text = await readText(current.image, {
        left: Math.round(list.left * sx),
        top: Math.round(y * sy),
        right: Math.round(list.right * sx),
        bottom: Math.round((y + rowH) * sy),
      });
      if (target.test(text)) hits.push(y);
    }
    if (!hits.length) return false;
    await tap((list.left + list.right) / 2, (hits[0] + hits.at(-1)) / 2 + rowH / 2);
    current = await next();
    return true;
  };
  // The panel's 传送 button and a teleport-point title, after resolving any overlap list.
  const teleportPanel = async () => {
    if (!(await confirm(current.image)).includes(buttonText)) await pickFromList();
    if (!(await confirm(current.image)).includes(buttonText)) return null;
    const title = (await readText(current.image, box(current.image, routine.title))).trim();
    return target.test(title) ? title : null;
  };

  const waypoints = mapWaypoints(mapImage, screen, routine.waypoint, exclude, scale)
    .map((w) => ({ ...w, d: dist(w, quest) }))
    .sort((a, b) => a.d - b.d);
  // A teleport point under the quest diamond is hidden by it but shows in the overlap list.
  let title = overlay ? await teleportPanel() : null,
    chosen = title ? { ...quest, d: 0 } : null,
    attempts = 0;
  if (!title && !waypoints.length)
    return result('no_waypoint', { screen: current.screen ?? 'unknown' });
  for (const waypoint of title ? [] : waypoints) {
    if (attempts >= (routine.waypointAttempts ?? 2)) break;
    // An opened panel covers the right of the map; a tap there would hit the panel instead.
    if ((chosen || overlay) && panel && inside(waypoint, panel)) continue;
    chosen = waypoint;
    attempts++;
    await tap(waypoint.x, waypoint.y);
    current = await next();
    if (current.screen !== mapScreen)
      return result('interrupted', { screen: current.screen ?? 'unknown' });
    title = await teleportPanel();
    if (title) break;
  }
  if (!title)
    return result('no_teleport_button', {
      screen: current.screen ?? 'unknown',
      waypoints: waypoints.length,
    });

  const button = ctx.rect(routine.button);
  await tap((button.left + button.right) / 2, (button.top + button.bottom) / 2);
  const evidence = {
    target: title,
    waypoints: waypoints.length,
    questDistance: Math.round(chosen.d),
  };
  for (;;) {
    current = await next(routine.pollMs ?? 500);
    if (done.has(current.screen)) break;
    if (now() - started >= maxMs)
      return result('timeout', { screen: current.screen ?? 'unknown', ...evidence });
  }
  // Loading finished: compare the minimap with the one before the map was opened.
  const minimapDiff =
    world && ctx.minimap
      ? Math.round(regionMotion(world.image, current.image, ctx.minimap, screen, 2) * 10) / 10
      : null;
  const moved = minimapDiff === null || minimapDiff >= (routine.movedDiff ?? 30);
  return result(moved ? 'teleported' : 'unverified', {
    screen: current.screen,
    ...evidence,
    ...(minimapDiff === null ? {} : { minimapDiff }),
  });
}

export const ROUTINES = { explore, dialogue, combat, navigate, approach, teleport };
