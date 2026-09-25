import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { StaleObservationError, assertFresh } from './device.mjs';
import { decodePng, encodePng, rgbAt, toRgba } from './png.mjs';
import { ROUTINES, ROUTINE_TYPES } from './routines.mjs';

const ANCHORS = {
  'top-left': [0, 0],
  top: [0.5, 0],
  'top-right': [1, 0],
  left: [0, 0.5],
  center: [0.5, 0.5],
  right: [1, 0.5],
  'bottom-left': [0, 1],
  bottom: [0.5, 1],
  'bottom-right': [1, 1],
};
const ID = /^[a-z0-9_]+$/;

function positive(value, name) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number.`);
}

function point(entry, name, reference) {
  if (!Object.hasOwn(ANCHORS, entry.anchor ?? 'top-left'))
    throw new Error(`${name}.anchor must be one of ${Object.keys(ANCHORS).join(', ')}.`);
  for (const axis of ['x', 'y'])
    if (!Number.isFinite(entry[axis]) || entry[axis] < 0)
      throw new Error(`${name}.${axis} must be a nonnegative number.`);
  if (entry.x > reference.width || entry.y > reference.height)
    throw new Error(`${name} lies outside the reference screen.`);
}

// A layout profile describes fixed on-screen controls for apps without an accessibility tree.
export function validateLayout(layout) {
  if (!layout || typeof layout !== 'object') throw new Error('Layout must be a JSON object.');
  const { name, packageNames, reference, screens = {}, buttons } = layout;
  if (typeof name !== 'string' || !name.trim()) throw new Error('Layout name is required.');
  if (!Array.isArray(packageNames) || !packageNames.length)
    throw new Error('Layout packageNames must list the app packages it applies to.');
  positive(reference?.width, 'reference.width');
  positive(reference?.height, 'reference.height');
  const { unknownRetries = 0, settleMs = 0 } = layout;
  if (!Number.isInteger(unknownRetries) || unknownRetries < 0 || unknownRetries > 5)
    throw new Error('unknownRetries must be an integer 0–5.');
  if (!Number.isInteger(settleMs) || settleMs < 0 || settleMs > 10_000)
    throw new Error('settleMs must be an integer 0–10000.');
  for (const [id, screen] of Object.entries(screens)) {
    if (!ID.test(id)) throw new Error(`Screen id "${id}" must match ${ID}.`);
    if (!Array.isArray(screen.probes ?? [])) throw new Error(`Screen ${id} probes must be a list.`);
    (screen.probes ?? []).forEach((probe, i) => {
      point(probe, `screens.${id}.probes[${i}]`, reference);
      if (
        !Array.isArray(probe.rgb) ||
        probe.rgb.length !== 3 ||
        !probe.rgb.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)
      )
        throw new Error(`screens.${id}.probes[${i}].rgb must be [r, g, b].`);
    });
  }
  if (!Array.isArray(buttons) || !buttons.length) throw new Error('Layout needs buttons.');
  const seen = new Set();
  for (const button of buttons) {
    if (!ID.test(button.id ?? '') || seen.has(button.id))
      throw new Error(`Button id "${button.id}" must be unique and match ${ID}.`);
    seen.add(button.id);
    if (typeof button.label !== 'string' || !button.label.trim())
      throw new Error(`Button ${button.id} needs a label.`);
    point(button, `buttons.${button.id}`, reference);
    positive(button.w, `buttons.${button.id}.w`);
    positive(button.h, `buttons.${button.id}.h`);
    for (const screen of button.screens ?? [])
      if (!Object.hasOwn(screens, screen))
        throw new Error(`Button ${button.id} references unknown screen ${screen}.`);
    if (button.text !== undefined)
      textBox({ anchor: button.anchor, ...button.text }, `buttons.${button.id}.text`, reference);
  }
  for (const [id, screen] of Object.entries(screens)) {
    if (!Array.isArray(screen.texts ?? [])) throw new Error(`Screen ${id} texts must be a list.`);
    const ids = new Set();
    for (const [i, region] of (screen.texts ?? []).entries()) {
      const name = `screens.${id}.texts[${i}]`;
      if (!ID.test(region.id ?? '') || ids.has(region.id))
        throw new Error(`${name}.id must be unique and match ${ID}.`);
      ids.add(region.id);
      if (typeof region.label !== 'string' || !region.label.trim())
        throw new Error(`${name} needs a label.`);
      textBox(region, name, reference);
      if (region.match !== undefined) {
        try {
          new RegExp(region.match, 'u');
        } catch {
          throw new Error(`${name}.match must be a regular expression.`);
        }
      }
    }
    for (const region of screen.texts ?? [])
      if (
        region.requires !== undefined &&
        (!ids.has(region.requires) || region.requires === region.id)
      )
        throw new Error(
          `screens.${id}.texts ${region.id} requires unknown region ${region.requires}.`,
        );
  }
  validateRoutines(layout, seen);
  return { ...layout, screens };
}

function validateRoutines(layout, buttonIds) {
  const { reference, screens = {}, joystick, minimap, routines = [] } = layout;
  if (joystick !== undefined) {
    point(joystick, 'joystick', reference);
    positive(joystick.radius, 'joystick.radius');
  }
  if (minimap !== undefined) textBox(minimap, 'minimap', reference);
  if (!Array.isArray(routines)) throw new Error('routines must be a list.');
  const ids = new Set();
  const screenList = (list, name) => {
    if (!Array.isArray(list ?? [])) throw new Error(`${name} must be a list of screens.`);
    for (const screen of list ?? [])
      if (!Object.hasOwn(screens, screen)) throw new Error(`${name} has unknown screen ${screen}.`);
  };
  const button = (id, key) => {
    if (!buttonIds.has(id)) throw new Error(`${key} uses unknown button ${id}.`);
  };
  const int = (routine, key, name, min, max) => {
    const value = routine[key];
    if (value !== undefined && (!Number.isInteger(value) || value < min || value > max))
      throw new Error(`${name}.${key} must be an integer ${min}–${max}.`);
  };
  for (const routine of routines) {
    const name = `routines.${routine.id}`;
    if (!ID.test(routine.id ?? '') || ids.has(routine.id))
      throw new Error(`Routine id "${routine.id}" must be unique and match ${ID}.`);
    ids.add(routine.id);
    if (!ROUTINE_TYPES.includes(routine.type))
      throw new Error(`${name}.type must be one of ${ROUTINE_TYPES.join(', ')}.`);
    if (typeof routine.label !== 'string' || !routine.label.trim())
      throw new Error(`${name} needs a label.`);
    if (!routine.screens?.length) throw new Error(`${name}.screens must list where it may start.`);
    screenList(routine.screens, `${name}.screens`);
    screenList(routine.stopScreens, `${name}.stopScreens`);
    int(routine, 'maxMs', name, 1000, 120_000);
    if (routine.type === 'dialogue') {
      if (routine.button === undefined) throw new Error(`${name}.button is required.`);
      button(routine.button, `${name}.button`);
      screenList(routine.doneScreens, `${name}.doneScreens`);
      int(routine, 'intervalMs', name, 0, 5000);
      int(routine, 'unknownLimit', name, 0, 20);
      continue;
    }
    if (routine.type === 'combat') {
      if (routine.attack === undefined) throw new Error(`${name}.attack is required.`);
      for (const key of ['attack', 'skill', 'burst'])
        if (routine[key] !== undefined) button(routine[key], `${name}.${key}`);
      if (!Array.isArray(routine.switchButtons ?? []))
        throw new Error(`${name}.switchButtons must be a list.`);
      for (const id of routine.switchButtons ?? []) button(id, `${name}.switchButtons`);
      for (const key of ['castMs', 'burstMs', 'attackMs', 'switchMs'])
        int(routine, key, name, 0, 5000);
      int(routine, 'attackTaps', name, 1, 10);
      int(routine, 'clearFrames', name, 1, 10);
      if (routine.enemy !== undefined) {
        const { enemy } = routine;
        textBox(enemy, `${name}.enemy`, reference);
        if (
          !Array.isArray(enemy.rgb) ||
          enemy.rgb.length !== 3 ||
          !enemy.rgb.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)
        )
          throw new Error(`${name}.enemy.rgb must be three integers 0–255.`);
        int(enemy, 'tolerance', `${name}.enemy`, 0, 255);
        if (enemy.tolerance === undefined) throw new Error(`${name}.enemy.tolerance is required.`);
        int(enemy, 'minPixels', `${name}.enemy`, 1, 100_000);
      }
      continue;
    }
    if (!joystick || !minimap) throw new Error(`${name} needs layout joystick and minimap.`);
    screenList(routine.turnScreens, `${name}.turnScreens`);
    for (const [screen, id] of Object.entries(routine.recover ?? {})) {
      screenList([screen], `${name}.recover`);
      button(id, `${name}.recover`);
    }
    if (routine.stuckButton !== undefined) button(routine.stuckButton, `${name}.stuckButton`);
    if (routine.deflection !== undefined && !(routine.deflection > 0 && routine.deflection <= 1))
      throw new Error(`${name}.deflection must be in (0, 1].`);
    for (const key of ['backstepMs', 'recoverMs']) int(routine, key, name, 0, 5000);
    for (const key of ['recoverAfter', 'stuckLimit']) int(routine, key, name, 1, 10);
  }
}

function textBox(region, name, reference) {
  point(region, name, reference);
  positive(region.w, `${name}.w`);
  positive(region.h, `${name}.h`);
}

export function loadLayout(path) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Could not read layout ${path}: ${error.message}`);
  }
  return validateLayout(parsed);
}

// Game HUDs keep controls a fixed distance from their anchor edge and scale with the short side.
export function resolvePoint(entry, screen, reference) {
  const [ax, ay] = ANCHORS[entry.anchor ?? 'top-left'];
  const scale = Math.min(screen.width / reference.width, screen.height / reference.height);
  return {
    x: ax * screen.width + (entry.x - ax * reference.width) * scale,
    y: ay * screen.height + (entry.y - ay * reference.height) * scale,
    scale,
  };
}

export function resolveRect(button, screen, reference) {
  const { x, y, scale } = resolvePoint(button, screen, reference);
  const halfW = (button.w * scale) / 2,
    halfH = (button.h * scale) / 2;
  const bounds = {
    left: Math.max(0, Math.round(x - halfW)),
    top: Math.max(0, Math.round(y - halfH)),
    right: Math.min(screen.width, Math.round(x + halfW)),
    bottom: Math.min(screen.height, Math.round(y + halfH)),
  };
  return bounds.right > bounds.left && bounds.bottom > bounds.top ? bounds : null;
}

function sample(image, screen, x, y) {
  const ix = Math.round((x * image.width) / screen.width),
    iy = Math.round((y * image.height) / screen.height);
  const sum = [0, 0, 0];
  let n = 0;
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      const px = ix + dx,
        py = iy + dy;
      if (px < 0 || py < 0 || px >= image.width || py >= image.height) continue;
      rgbAt(image, px, py).forEach((v, i) => (sum[i] += v));
      n++;
    }
  return n ? sum.map((v) => Math.round(v / n)) : null;
}

// The first screen whose probes all match wins; screens without probes are never detected.
export function detectScreen(image, screen, layout) {
  const results = {};
  let detected = null;
  for (const [id, definition] of Object.entries(layout.screens)) {
    const probes = (definition.probes ?? []).map((probe) => {
      const { x, y } = resolvePoint(probe, screen, layout.reference);
      const observed = sample(image, screen, x, y);
      const tolerance = probe.tolerance ?? 40;
      const matched =
        observed !== null && observed.every((v, i) => Math.abs(v - probe.rgb[i]) <= tolerance);
      return { x: Math.round(x), y: Math.round(y), expected: probe.rgb, observed, matched };
    });
    const matched = probes.length > 0 && probes.every((p) => p.matched);
    results[id] = { matched, probes };
    if (matched && !detected) detected = id;
  }
  return { screen: detected, results };
}

// Coarse luminance grid: distinguishes screen changes without exact pixel equality.
export function visualHash(image) {
  const cols = 16,
    rows = 9;
  const levels = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      let sum = 0,
        n = 0;
      for (let s = 0; s < 4; s++)
        for (let t = 0; t < 4; t++) {
          const x = Math.floor(((c + (s + 0.5) / 4) * image.width) / cols);
          const y = Math.floor(((r + (t + 0.5) / 4) * image.height) / rows);
          const [red, green, blue] = rgbAt(image, x, y);
          sum += 0.299 * red + 0.587 * green + 0.114 * blue;
          n++;
        }
      levels.push(Math.min(7, Math.floor(sum / n / 32)));
    }
  return levels.join('');
}

export function layoutButtons(layout, screen, detected) {
  return layout.buttons
    .filter((b) => !detected || !b.screens?.length || b.screens.includes(detected))
    .map((button) => ({ button, bounds: resolveRect(button, screen, layout.reference) }))
    .filter(({ bounds }) => bounds);
}

// Text regions are read only on a recognized screen: button captions and screen-level texts.
export function layoutTextRegions(layout, screen, detected) {
  if (!detected) return [];
  const regions = layoutButtons(layout, screen, detected)
    .filter(({ button }) => button.text)
    .map(({ button }) => ({
      key: `button:${button.id}`,
      bounds: resolveRect({ anchor: button.anchor, ...button.text }, screen, layout.reference),
    }));
  for (const region of layout.screens[detected].texts ?? [])
    regions.push({
      key: `screen:${region.id}`,
      bounds: resolveRect(region, screen, layout.reference),
    });
  return regions.filter(({ bounds }) => bounds);
}

// Screen-space boxes map onto the screenshot, which may be captured at another resolution.
export async function readTexts(recognizer, image, screen, regions) {
  const texts = {};
  if (!recognizer) return texts;
  const sx = image.width / screen.width,
    sy = image.height / screen.height;
  for (const { key, bounds } of regions) {
    const result = await recognizer.recognize(image, {
      left: Math.round(bounds.left * sx),
      top: Math.round(bounds.top * sy),
      right: Math.round(bounds.right * sx),
      bottom: Math.round(bounds.bottom * sy),
    });
    if (result === null) return null;
    if (result.text) texts[key] = result.text;
  }
  return texts;
}

const virtualElement = (id, fields) => ({
  id,
  text: '',
  label: '',
  resourceId: '',
  hint: '',
  clickable: false,
  editable: false,
  scrollable: false,
  enabled: true,
  focused: false,
  password: false,
  checkable: false,
  checked: false,
  selected: false,
  ...fields,
});

function describeAction(action, layout) {
  if (action.type === 'global') return `system ${action.name.toUpperCase()}`;
  if (action.elementId?.startsWith('layout-routine.')) {
    const routine = layout.routines?.find((r) => r.id === action.elementId.slice(15));
    return routine ? `routine "${routine.label}"` : action.type;
  }
  const id = action.elementId?.startsWith('layout.') ? action.elementId.slice(7) : undefined;
  const button = id && layout.buttons.find((b) => b.id === id);
  return button ? `"${button.label}"` : action.type;
}

// Code-observed effect of the previous executed action. Traces keep it for outcome checks; it is
// not sent to Jev, because replayed decisions showed it made Jev repeat completed interactions.
function lastActionEffect(last, screen, layout) {
  if (!last) return undefined;
  return {
    control: describeAction(last.action, layout),
    before: last.screen,
    after: screen,
    ...(last.routine ? { routine: last.routine } : {}),
  };
}

// Routines a device can run (it needs raw touch input) on the detected screen. Each is placed on
// the control it drives: the joystick for explore, otherwise its main button.
export function layoutRoutines(layout, screen, detected) {
  if (!detected) return [];
  const joystickBounds = () => {
    const { x, y, scale } = resolvePoint(layout.joystick, screen, layout.reference);
    const r = layout.joystick.radius * scale;
    return {
      left: Math.max(0, Math.round(x - r)),
      top: Math.max(0, Math.round(y - r)),
      right: Math.min(screen.width, Math.round(x + r)),
      bottom: Math.min(screen.height, Math.round(y + r)),
    };
  };
  const buttonBounds = (id) =>
    resolveRect(
      layout.buttons.find((button) => button.id === id),
      screen,
      layout.reference,
    );
  return (layout.routines ?? [])
    .filter((routine) => routine.screens.includes(detected))
    .map((routine) => ({
      routine,
      bounds:
        routine.type === 'explore'
          ? joystickBounds()
          : buttonBounds(routine.type === 'dialogue' ? routine.button : routine.attack),
    }));
}

// Add code-owned fixed controls to an observation; Jev still chooses whether and which to tap.
// OCR texts (keyed `button:<id>` or `screen:<id>`) become element text Jev can read.
export function layoutObservation(
  base,
  image,
  layout,
  { last, texts = {}, ocr, routines = false } = {},
) {
  const { screen: detected, results } = detectScreen(image, base.screen, layout);
  const description = detected ? layout.screens[detected].description || detected : undefined;
  const hasProbes = Object.values(layout.screens).some((s) => s.probes?.length);
  const previousAction = lastActionEffect(last, detected || 'unknown', layout);
  // `match` rejects OCR noise from busy backgrounds; `requires` keeps a region only with another.
  const regions = detected ? (layout.screens[detected].texts ?? []) : [];
  const accepted = new Map();
  for (const region of regions) {
    const text = texts[`screen:${region.id}`];
    if (text && (region.match === undefined || new RegExp(region.match, 'u').test(text)))
      accepted.set(region.id, text);
  }
  const screenTexts = regions.flatMap((region) => {
    const text = accepted.get(region.id);
    const bounds =
      text &&
      (region.requires === undefined || accepted.has(region.requires)) &&
      resolveRect(region, base.screen, layout.reference);
    return bounds
      ? [virtualElement(`layout-text.${region.id}`, { text, label: region.label, bounds })]
      : [];
  });
  const elements = [
    ...base.elements,
    virtualElement('layout-screen', {
      text: detected
        ? `Detected game screen: ${description}`
        : hasProbes
          ? 'Game screen not recognized by the layout probes (e.g. a loading or unfamiliar screen), so no fixed control is offered; wait for it to change or report that you are blocked.'
          : 'Game screen is not visible to the agent; every fixed control is offered.',
      bounds: { left: 0, top: 0, right: base.screen.width, bottom: base.screen.height },
    }),
    ...screenTexts,
    ...(detected || !hasProbes ? layoutButtons(layout, base.screen, detected) : []).map(
      ({ button, bounds }) =>
        virtualElement(`layout.${button.id}`, {
          text: texts[`button:${button.id}`] ?? '',
          label: button.description ? `${button.label}: ${button.description}` : button.label,
          resourceId: `layout:${button.id}`,
          bounds,
          clickable: true,
        }),
    ),
    ...(routines ? layoutRoutines(layout, base.screen, detected) : []).map(({ routine, bounds }) =>
      virtualElement(`layout-routine.${routine.id}`, {
        label: routine.description ? `${routine.label}: ${routine.description}` : routine.label,
        resourceId: `layout-routine:${routine.id}`,
        bounds,
        clickable: true,
      }),
    ),
  ];
  const visual = {
    profile: layout.name,
    screen: detected || 'unknown',
    ...(description ? { description } : {}),
    matchedProbes: Object.fromEntries(
      Object.entries(results).map(([id, r]) => [id, r.probes.filter((p) => p.matched).length]),
    ),
    hash: visualHash(image),
  };
  const content = {
    deviceId: base.deviceId,
    phone: base.phone,
    screen: base.screen,
    elements,
    visual,
  };
  return {
    ...content,
    layout: {
      profile: visual.profile,
      screen: visual.screen,
      description,
      signature: createHash('sha256')
        .update(
          JSON.stringify([
            visual.screen,
            elements.filter((e) => e.id.startsWith('layout')).map((e) => [e.id, e.text]),
          ]),
        )
        .digest('hex'),
      ...(previousAction ? { previousAction } : {}),
      ...(ocr ? { ocr } : {}),
    },
    fingerprint: createHash('sha256').update(JSON.stringify(content)).digest('hex'),
    observedAt: Date.now(),
  };
}

function screenOnlyObservation(deviceId, packageName, image) {
  return {
    deviceId,
    phone: {
      packageName,
      currentApp: packageName,
      isEditable: false,
      inputElementId: undefined,
      focusEvidence: 'none',
      keyboardVisible: false,
      focusedElement: { resourceId: '', className: '' },
    },
    screen: { width: image.width, height: image.height },
    elements: [],
  };
}

// Wrap an instance so both the agent loop and act()'s freshness check see the layout controls.
// `recognizer` reads declared text regions; without one (or without OCR installed) none are read.
export function withLayout(device, layout, { recognizer } = {}) {
  const packages = new Set(layout.packageNames);
  const baseObserve = device.observe.bind(device);
  const baseListApps = device.listApps?.bind(device);
  const retries = Object.values(layout.screens).some((s) => s.probes?.length)
    ? (layout.unknownRetries ?? 0)
    : 0;
  device.layout = layout;
  const baseAct = device.act?.bind(device);
  let last;
  const observeLayout = async (base, image) => {
    const { screen: detected } = detectScreen(image, base.screen, layout);
    const regions = layoutTextRegions(layout, base.screen, detected);
    let texts = {},
      ocr;
    if (regions.length && recognizer) {
      const start = performance.now();
      try {
        const read = await readTexts(recognizer, image, base.screen, regions);
        texts = read ?? {};
        ocr = read
          ? { regions: regions.length, ms: Math.round(performance.now() - start) }
          : { unavailable: true };
      } catch (error) {
        ocr = { error: error.message };
      }
    }
    return layoutObservation(base, image, layout, {
      last,
      texts,
      ocr,
      routines: typeof device.touch === 'function',
    });
  };
  const observeOnce = async () => {
    // ADB: game surfaces often break uiautomator, so read the foreground package and pixels only.
    if (typeof device.foregroundPackage === 'function') {
      const packageName = await device.foregroundPackage();
      if (!packages.has(packageName)) return baseObserve();
      const image = decodePng(await device.screenshot());
      return observeLayout(screenOnlyObservation(device.deviceId, packageName, image), image);
    }
    const base = await baseObserve();
    if (!packages.has(base.phone.packageName)) return base;
    return observeLayout(base, decodePng(await device.screenshot()));
  };
  // Game transitions animate for a moment; re-capture instead of showing Jev a half-drawn frame.
  device.observe = async () => {
    let observation = await observeOnce();
    for (let i = 0; i < retries && observation.layout?.screen === 'unknown'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      observation = await observeOnce();
    }
    return observation;
  };
  // Record only after input was attempted; stale rejections happen before input and change nothing.
  if (baseAct)
    device.act = async (action, options) => {
      const screen = options?.expected?.layout?.screen;
      if (action?.type === 'tap-element' && action.elementId?.startsWith('layout-routine.'))
        return runLayoutRoutine(action, options, screen);
      try {
        const result = await baseAct(action, options);
        last = screen ? { action, screen } : undefined;
        return result;
      } catch (error) {
        if (!(error instanceof StaleObservationError)) last = undefined;
        throw error;
      }
    };
  const runLayoutRoutine = async (action, options = {}, screen) => {
    const current = await device.observe();
    if (!options.expected) throw new Error('Routines require their original observation.');
    assertFresh(current, options.expected, action, options.maxAgeMs);
    const routine = layout.routines.find((r) => `layout-routine.${r.id}` === action.elementId);
    if (!routine || typeof device.touch !== 'function')
      throw new Error('Routine is not available.');
    const dims = current.screen;
    last = { action, screen, routine: { routine: routine.id, status: 'started' } };
    const joystick = layout.joystick && resolvePoint(layout.joystick, dims, layout.reference);
    const result = await ROUTINES[routine.type]({
      routine,
      screen: dims,
      joystick: joystick && {
        x: Math.round(joystick.x),
        y: Math.round(joystick.y),
        radius: layout.joystick.radius * joystick.scale,
      },
      minimap: layout.minimap && resolveRect(layout.minimap, dims, layout.reference),
      enemyBounds: routine.enemy && resolveRect(routine.enemy, dims, layout.reference),
      buttonCenter: (id) => {
        const b = resolveRect(
          layout.buttons.find((button) => button.id === id),
          dims,
          layout.reference,
        );
        return { x: Math.floor((b.left + b.right) / 2), y: Math.floor((b.top + b.bottom) / 2) };
      },
      // PNG capture: raw `screencap` returned stale frames on an LDPlayer emulator.
      frame: async () => {
        const image = decodePng(await device.screenshot());
        return { image, screen: detectScreen(image, dims, layout).screen };
      },
      touch: (event, px, py) => device.touch(event, px, py),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: () => performance.now(),
      random: device.random ?? Math.random,
    });
    last = { action, screen, routine: result };
    return { routine: result };
  };
  if (baseListApps && layout.appLabel)
    device.listApps = async () => {
      const apps = (await baseListApps()).map((app) =>
        packages.has(app.packageName) ? { ...app, label: layout.appLabel } : app,
      );
      device.installedApps = apps;
      return apps;
    };
  return device;
}

// Calibration aid: outline each resolved button and probe on a screenshot.
export function annotateScreenshot(png, layout, screen) {
  const image = toRgba(decodePng(png));
  screen ??= { width: image.width, height: image.height };
  const sx = image.width / screen.width,
    sy = image.height / screen.height;
  const paint = (x, y, [r, g, b]) => {
    if (x < 0 || y < 0 || x >= image.width || y >= image.height) return;
    const i = (y * image.width + x) * 4;
    image.pixels[i] = r;
    image.pixels[i + 1] = g;
    image.pixels[i + 2] = b;
    image.pixels[i + 3] = 255;
  };
  const box = ({ left, top, right, bottom }, color, thickness = 3) => {
    const [l, t, r, b] = [left * sx, top * sy, right * sx, bottom * sy].map(Math.round);
    for (let k = 0; k < thickness; k++) {
      for (let x = l; x < r; x++) {
        paint(x, t + k, color);
        paint(x, b - 1 - k, color);
      }
      for (let y = t; y < b; y++) {
        paint(l + k, y, color);
        paint(r - 1 - k, y, color);
      }
    }
  };
  const detection = detectScreen(image, screen, layout);
  const buttons = layoutButtons(layout, screen, null);
  for (const { bounds } of buttons) box(bounds, [255, 0, 255]);
  for (const { probes } of Object.values(detection.results))
    for (const probe of probes)
      box(
        { left: probe.x - 6, top: probe.y - 6, right: probe.x + 7, bottom: probe.y + 7 },
        probe.matched ? [0, 255, 0] : [255, 0, 0],
        2,
      );
  return {
    png: encodePng(image),
    detection,
    buttons: buttons.map(({ button, bounds }) => ({ id: button.id, label: button.label, bounds })),
  };
}
