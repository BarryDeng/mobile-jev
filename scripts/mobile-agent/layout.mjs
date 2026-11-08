import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { bestIconAt, iconTemplate } from './icon-match.mjs';
import { StaleObservationError, assertFresh } from './device.mjs';
import { decodePng, encodePng, rgbAt, toRgba } from './png.mjs';
import {
  ROUTINES,
  ROUTINE_TYPES,
  enemyArrow,
  enemyBars,
  findEnemies,
  healthFill,
  hudDistance,
} from './routines.mjs';

const round2 = (value) => Math.round(value * 100) / 100;

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
  // `extends` copies another routine's settings, so a variant overrides only what differs.
  if (Array.isArray(layout.routines))
    layout = {
      ...layout,
      routines: layout.routines.map((routine) => {
        if (routine?.extends === undefined) return routine;
        const base = layout.routines.find((r) => r.id === routine.extends && !r.extends);
        if (!base) throw new Error(`routines.${routine.id}.extends names no base routine.`);
        const { extends: _, ...own } = routine;
        return { ...base, ...own };
      }),
    };
  const { name, packageNames, reference, screens = {}, statusTexts = [], buttons } = layout;
  if (typeof name !== 'string' || !name.trim()) throw new Error('Layout name is required.');
  if (!Array.isArray(packageNames) || !packageNames.length)
    throw new Error('Layout packageNames must list the app packages it applies to.');
  positive(reference?.width, 'reference.width');
  positive(reference?.height, 'reference.height');
  if (reference.uiAspect !== undefined) {
    positive(reference.uiAspect, 'reference.uiAspect');
    if (reference.uiAspect > reference.width / reference.height + 1e-6)
      throw new Error('reference.uiAspect must not exceed the reference width/height ratio.');
  }
  const { unknownRetries = 0, settleMs = 0 } = layout;
  if (!Number.isInteger(unknownRetries) || unknownRetries < 0 || unknownRetries > 5)
    throw new Error('unknownRetries must be an integer 0–5.');
  if (!Number.isInteger(settleMs) || settleMs < 0 || settleMs > 10_000)
    throw new Error('settleMs must be an integer 0–10000.');
  for (const [id, screen] of Object.entries(screens)) {
    if (!ID.test(id)) throw new Error(`Screen id "${id}" must match ${ID}.`);
    if (!Array.isArray(screen.probes ?? [])) throw new Error(`Screen ${id} probes must be a list.`);
    if (
      screen.drift !== undefined &&
      !(Number.isFinite(screen.drift?.x) && screen.drift.x >= 0 && screen.drift.x <= 200)
    )
      throw new Error(`screens.${id}.drift.x must be a number 0–200.`);
    (screen.probes ?? []).forEach((probe, i) => {
      point(probe, `screens.${id}.probes[${i}]`, reference);
      if (probe.drift !== undefined && typeof probe.drift !== 'boolean')
        throw new Error(`screens.${id}.probes[${i}].drift must be true or false.`);
      // A template probe matches an icon image (a PNG next to the layout) centred near the point.
      if (probe.template !== undefined) {
        if (typeof probe.template !== 'string' || !probe.template.endsWith('.png') || probe.drift)
          throw new Error(`screens.${id}.probes[${i}].template must be a PNG file (not drift).`);
        if (probe.min !== undefined && !(probe.min > 0 && probe.min < 1))
          throw new Error(`screens.${id}.probes[${i}].min must be a score between 0 and 1.`);
        if (
          probe.search !== undefined &&
          !(Number.isInteger(probe.search) && probe.search >= 0 && probe.search <= 20)
        )
          throw new Error(`screens.${id}.probes[${i}].search must be an integer 0–20.`);
        return;
      }
      if (
        !Array.isArray(probe.rgb) ||
        probe.rgb.length !== 3 ||
        !probe.rgb.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)
      )
        throw new Error(`screens.${id}.probes[${i}].rgb must be [r, g, b].`);
    });
  }
  if (!Array.isArray(statusTexts)) throw new Error('statusTexts must be a list.');
  const statusIds = new Set();
  for (const [i, region] of statusTexts.entries()) {
    const name = `statusTexts[${i}]`;
    if (!ID.test(region.id ?? '') || statusIds.has(region.id))
      throw new Error(`${name}.id must be unique and match ${ID}.`);
    statusIds.add(region.id);
    if (typeof region.label !== 'string' || !region.label.trim())
      throw new Error(`${name} needs a label.`);
    textBox(region, name, reference);
    if (!Array.isArray(region.screens) || !region.screens.length)
      throw new Error(`${name}.screens must list where it is visible.`);
    for (const screen of region.screens)
      if (!Object.hasOwn(screens, screen)) throw new Error(`${name} has unknown screen ${screen}.`);
    if (region.match !== undefined) new RegExp(region.match, 'u');
    if (region.low !== undefined && !(region.low > 0 && region.low < 1))
      throw new Error(`${name}.low must be a ratio between 0 and 1.`);
  }
  if (
    layout.playbook !== undefined &&
    (!Array.isArray(layout.playbook) ||
      !layout.playbook.every((tip) => typeof tip === 'string' && tip.trim()))
  )
    throw new Error('playbook must be a list of non-empty strings.');
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
    if (
      button.holdMs !== undefined &&
      (!Number.isInteger(button.holdMs) || button.holdMs < 10 || button.holdMs > 2000)
    )
      throw new Error(`buttons.${button.id}.holdMs must be an integer from 10 to 2000.`);
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
      if (region.remember !== undefined && typeof region.remember !== 'boolean')
        throw new Error(`${name}.remember must be a boolean.`);
      for (const pattern of Object.keys(region.fix ?? {})) {
        try {
          new RegExp(pattern, 'gu');
        } catch {
          throw new Error(`${name}.fix keys must be regular expressions.`);
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
  const { reference, screens = {}, joystick, minimap, enemy, healthBar, routines = [] } = layout;
  if (healthBar !== undefined) {
    textBox(healthBar, 'healthBar', reference);
    if (
      !Array.isArray(healthBar.rgb) ||
      healthBar.rgb.length !== 3 ||
      !healthBar.rgb.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)
    )
      throw new Error('healthBar.rgb must be three integers 0–255.');
    if (!Array.isArray(healthBar.screens) || !healthBar.screens.length)
      throw new Error('healthBar.screens must list screens.');
    for (const screen of healthBar.screens)
      if (!Object.hasOwn(screens, screen))
        throw new Error(`healthBar.screens has unknown screen ${screen}.`);
    for (const key of ['tolerance', 'minDrop', 'minVisible'])
      if (healthBar[key] !== undefined) positive(healthBar[key], `healthBar.${key}`);
  }
  if (joystick !== undefined) {
    point(joystick, 'joystick', reference);
    positive(joystick.radius, 'joystick.radius');
  }
  if (minimap !== undefined) textBox(minimap, 'minimap', reference);
  if (enemy !== undefined) {
    textBox(enemy, 'enemy', reference);
    if (
      !Array.isArray(enemy.rgb) ||
      enemy.rgb.length !== 3 ||
      !enemy.rgb.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)
    )
      throw new Error('enemy.rgb must be three integers 0–255.');
    if (!Number.isInteger(enemy.tolerance) || enemy.tolerance < 0 || enemy.tolerance > 255)
      throw new Error('enemy.tolerance must be an integer 0–255.');
    for (const key of ['minWidth', 'maxHeight', 'nearWidth'])
      if (enemy[key] !== undefined) positive(enemy[key], `enemy.${key}`);
    if (enemy.levelText !== undefined) {
      if (typeof enemy.levelText !== 'string' || !enemy.levelText)
        throw new Error('enemy.levelText must be a regular expression string.');
      new RegExp(enemy.levelText);
    }
    if (enemy.arrowRing !== undefined) {
      const ring = enemy.arrowRing;
      positive(ring.inner, 'enemy.arrowRing.inner');
      positive(ring.outer, 'enemy.arrowRing.outer');
      if (ring.outer <= ring.inner) throw new Error('enemy.arrowRing.outer must exceed inner.');
    }
    for (const screen of enemy.screens ?? [])
      if (!Object.hasOwn(screens, screen))
        throw new Error(`enemy.screens has unknown screen ${screen}.`);
  }
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
      for (const [screen, id] of Object.entries(routine.recover ?? {})) {
        screenList([screen], `${name}.recover`);
        button(id, `${name}.recover`);
      }
      if (routine.revive !== undefined) {
        const { screen, confirm, cancel } = routine.revive;
        screenList([screen], `${name}.revive.screen`);
        button(confirm, `${name}.revive.confirm`);
        button(cancel, `${name}.revive.cancel`);
      }
      const alive = routine.alivePortrait;
      if (alive !== undefined) {
        positive(alive.w, `${name}.alivePortrait.w`);
        positive(alive.h, `${name}.alivePortrait.h`);
      }
      continue;
    }
    if (routine.type === 'track_quest') {
      if (routine.open === undefined) throw new Error(`${name}.open is required.`);
      button(routine.open, `${name}.open`);
      screenList(routine.doneScreens, `${name}.doneScreens`);
      if (!routine.doneScreens?.length) throw new Error(`${name}.doneScreens must list arrivals.`);
      if (routine.mapScreens !== undefined) screenList(routine.mapScreens, `${name}.mapScreens`);
      for (const key of ['hud', 'title', 'button']) {
        if (!routine[key]) throw new Error(`${name}.${key} is required.`);
        textBox(routine[key], `${name}.${key}`, reference);
      }
      if (routine.name !== undefined) textBox(routine.name, `${name}.name`, reference);
      for (const key of ['openMs', 'settleMs']) int(routine, key, name, 0, 5000);
      for (const key of ['keepMap', 'retrack'])
        if (routine[key] !== undefined && typeof routine[key] !== 'boolean')
          throw new Error(`${name}.${key} must be true or false.`);
      continue;
    }
    if (routine.type === 'teleport') {
      if (routine.open === undefined) throw new Error(`${name}.open is required.`);
      button(routine.open, `${name}.open`);
      if (routine.zoomIn !== undefined) button(routine.zoomIn, `${name}.zoomIn`);
      if (routine.zoomButton !== undefined) button(routine.zoomButton, `${name}.zoomButton`);
      if (routine.maxZoom !== undefined) button(routine.maxZoom, `${name}.maxZoom`);
      if (routine.zoomOut !== undefined) button(routine.zoomOut, `${name}.zoomOut`);
      int(routine, 'maxZoomTaps', name, 0, 10);
      int(routine, 'zoomOutTaps', name, 0, 8);
      if (
        routine.track !== undefined &&
        !layout.routines.some((r) => r.id === routine.track && r.type === 'track_quest')
      )
        throw new Error(`${name}.track must name a track_quest routine.`);
      int(routine, 'zoomTaps', name, 0, 8);
      screenList(routine.doneScreens, `${name}.doneScreens`);
      if (!routine.doneScreens?.length) throw new Error(`${name}.doneScreens must list arrivals.`);
      if (routine.mapScreen !== undefined) screenList([routine.mapScreen], `${name}.mapScreen`);
      if (routine.forceScreens !== undefined)
        screenList(routine.forceScreens, `${name}.forceScreens`);
      for (const key of ['title', 'button']) {
        if (!routine[key]) throw new Error(`${name}.${key} is required.`);
        textBox(routine[key], `${name}.${key}`, reference);
      }
      for (const key of ['list', 'panel'])
        if (routine[key] !== undefined) textBox(routine[key], `${name}.${key}`, reference);
      (routine.exclude ?? []).forEach((rect, i) =>
        textBox(rect, `${name}.exclude.${i}`, reference),
      );
      const range = (value, key) => {
        if (!Array.isArray(value) || value.length !== 2 || !(value[0] >= 0 && value[1] >= value[0]))
          throw new Error(`${key} must be [min, max].`);
      };
      const color = (target, key) => {
        if (!Array.isArray(target?.rgb) || target.rgb.length !== 3)
          throw new Error(`${key}.rgb must be three integers 0–255.`);
        if (target.tolerance === undefined) throw new Error(`${key}.tolerance is required.`);
      };
      const waypoint = (spec, key) => {
        color(spec, key);
        if (!spec.shapes?.length) throw new Error(`${key}.shapes is required.`);
        for (const shape of spec.shapes) {
          for (const field of ['pixels', 'w', 'h']) range(shape[field], `${key}.shapes.${field}`);
          if (shape.ringRadius !== undefined)
            positive(shape.ringRadius, `${key}.shapes.ringRadius`);
        }
        const { ring } = spec;
        positive(ring?.radius, `${key}.ring.radius`);
        int(ring, 'white', `${key}.ring`, 0, 255);
        int(ring, 'min', `${key}.ring`, 1, 16);
      };
      if (routine.targetWaypoint === undefined) {
        const quests = Array.isArray(routine.quest) ? routine.quest : [routine.quest];
        if (!routine.quest || !quests.length) throw new Error(`${name}.quest is required.`);
        quests.forEach((quest, i) => {
          const key = `${name}.quest${Array.isArray(routine.quest) ? `[${i}]` : ''}`;
          color(quest, key);
          range(quest.pixels, `${key}.pixels`);
          // Tall icons (the "!" quest pin) give separate width and height ranges instead of size.
          if (quest.w !== undefined || quest.h !== undefined) {
            range(quest.w, `${key}.w`);
            range(quest.h, `${key}.h`);
          } else range(quest.size, `${key}.size`);
          if (quest.stack !== undefined) range(quest.stack, `${key}.stack`);
        });
      } else waypoint(routine.targetWaypoint, `${name}.targetWaypoint`);
      waypoint(routine.waypoint, `${name}.waypoint`);
      for (const key of ['openMs', 'tapSettleMs', 'pollMs']) int(routine, key, name, 0, 5000);
      int(routine, 'waypointAttempts', name, 1, 5);
      if (routine.nearRadius !== undefined) positive(routine.nearRadius, `${name}.nearRadius`);
      if (routine.distance !== undefined) textBox(routine.distance, `${name}.distance`, reference);
      if (routine.nearMeters !== undefined) positive(routine.nearMeters, `${name}.nearMeters`);
      if (
        routine.questText !== undefined &&
        !Object.values(screens).some((s) => s.texts?.some((t) => t.id === routine.questText))
      )
        throw new Error(`${name}.questText must name a screen text region.`);
      continue;
    }
    if (!joystick || !minimap) throw new Error(`${name} needs layout joystick and minimap.`);
    const camera = () => {
      const { camera } = layout;
      if (!camera) throw new Error(`${name} needs a layout camera.`);
      point(camera, 'camera', reference);
      positive(camera.degreesPerPixel, 'camera.degreesPerPixel');
      positive(camera.maxDrag, 'camera.maxDrag');
      if (camera.deadzone !== undefined && !(camera.deadzone >= 0))
        throw new Error('camera.deadzone must be >= 0.');
      if (
        camera.curve !== undefined &&
        !(
          Array.isArray(camera.curve) &&
          camera.curve.length >= 2 &&
          camera.curve.every(
            (p, i, all) =>
              Array.isArray(p) &&
              p.length === 2 &&
              p.every((v) => Number.isFinite(v) && v >= 0) &&
              (i === 0 || (p[0] > all[i - 1][0] && p[1] > all[i - 1][1])),
          )
        )
      )
        throw new Error('camera.curve must be [pixels, degrees] pairs, both increasing.');
    };
    if (routine.type === 'approach') {
      camera();
      if (!enemy?.nearWidth) throw new Error(`${name} needs a layout enemy with nearWidth.`);
      positive(routine.viewDegreesPerPixel, `${name}.viewDegreesPerPixel`);
      int(routine, 'hopMs', name, 100, 5000);
      int(routine, 'farHopMs', name, 100, 5000);
      int(routine, 'dragSettleMs', name, 0, 5000);
      for (const key of ['stuckLimit', 'lostLimit']) int(routine, key, name, 1, 10);
      int(routine, 'scanSteps', name, 0, 12);
      int(routine, 'arrowTurns', name, 0, 10);
      if (routine.scanDeg !== undefined) positive(routine.scanDeg, `${name}.scanDeg`);
      if (routine.stuckButton !== undefined) button(routine.stuckButton, `${name}.stuckButton`);
      continue;
    }
    if (routine.type === 'navigate') {
      camera();
      if (routine.route !== undefined) {
        const { route } = routine;
        if (typeof route !== 'object' || route === null)
          throw new Error(`${name}.route must be an object.`);
        textBox(route.bounds, `${name}.route.bounds`, reference);
        const colors = (list, key) => {
          if (
            !Array.isArray(list) ||
            !list.length ||
            !list.every(
              (c) =>
                Array.isArray(c) &&
                c.length === 3 &&
                c.every((v) => Number.isInteger(v) && v >= 0 && v <= 255),
            )
          )
            throw new Error(`${name}.route.palette.${key} must list RGB triplets.`);
        };
        colors(route.palette?.walk, 'walk');
        colors(route.palette?.block, 'block');
        if (route.palette.water !== undefined) colors(route.palette.water, 'water');
        int(route, 'cells', `${name}.route`, 15, 90);
        int(route, 'hopMs', `${name}.route`, 100, 5000);
        int(route, 'holdHops', `${name}.route`, 0, 20);
      }
      if (routine.revealButton !== undefined) button(routine.revealButton, `${name}.revealButton`);
      if (routine.jumpButton !== undefined) button(routine.jumpButton, `${name}.jumpButton`);
      int(routine, 'jumpEvery', name, 500, 60_000);
      int(routine, 'jumpGapMs', name, 0, 2000);
      if (routine.jumpEvery && !routine.jumpButton)
        throw new Error(`${name}.jumpEvery needs jumpButton.`);
      screenList(routine.airScreens, `${name}.airScreens`);
      if (routine.airScreens?.some((s) => !routine.screens?.includes(s)))
        throw new Error(`${name}.airScreens must be among its screens.`);
      int(routine, 'revealTaps', name, 0, 5);
      int(routine, 'revealMs', name, 0, 10_000);
      const { marker } = routine;
      const rgbTriplet = (value, key) => {
        if (
          value !== undefined &&
          (!Array.isArray(value) ||
            value.length !== 3 ||
            !value.every((v) => Number.isInteger(v) && v >= 0 && v <= 255))
        )
          throw new Error(`${name}.marker.${key} must be three integers 0–255.`);
      };
      rgbTriplet(marker?.rgb, 'rgb');
      rgbTriplet(marker?.min, 'min');
      rgbTriplet(marker?.max, 'max');
      const hasColor = marker?.rgb !== undefined && marker?.tolerance !== undefined;
      const hasRange = marker?.min !== undefined && marker?.max !== undefined;
      if (!hasColor && !hasRange)
        throw new Error(
          `${name}.marker needs rgb+tolerance or min+max to recognise the marker colour.`,
        );
      int(marker, 'tolerance', `${name}.marker`, 0, 255);
      if (marker.colors !== undefined) {
        if (!Array.isArray(marker.colors))
          throw new Error(`${name}.marker.colors must be a list of { rgb, tolerance }.`);
        marker.colors.forEach((color, i) => {
          if (typeof color !== 'object' || color === null)
            throw new Error(`${name}.marker.colors[${i}] must be { rgb, tolerance }.`);
          rgbTriplet(color.rgb, `colors[${i}].rgb`);
          if (color.rgb === undefined)
            throw new Error(`${name}.marker.colors[${i}].rgb is required.`);
          int(color, 'tolerance', `${name}.marker.colors[${i}]`, 0, 255);
          if (color.hud !== undefined)
            textBox(color.hud, `${name}.marker.colors[${i}].hud`, reference);
          if (
            color.hudShare !== undefined &&
            !(typeof color.hudShare === 'number' && color.hudShare > 0 && color.hudShare <= 1)
          )
            throw new Error(`${name}.marker.colors[${i}].hudShare must be in (0, 1].`);
        });
      }
      if (marker.icons !== undefined) {
        const { icons } = marker;
        const where = `${name}.marker.icons`;
        if (typeof icons !== 'object' || icons === null)
          throw new Error(`${where} must be an object.`);
        textBox(icons.hud, `${where}.hud`, reference);
        if (icons.distance !== undefined) textBox(icons.distance, `${where}.distance`, reference);
        const fraction = (value, key) => {
          if (value !== undefined && !(typeof value === 'number' && value > 0 && value <= 1))
            throw new Error(`${key} must be in (0, 1].`);
        };
        fraction(icons.threshold, `${where}.threshold`);
        fraction(icons.hudThreshold, `${where}.hudThreshold`);
        fraction(icons.maxJump, `${where}.maxJump`);
        for (const key of ['metresPerHalf', 'rim'])
          if (icons[key] !== undefined) positive(icons[key], `${where}.${key}`);
        if (
          typeof icons.kinds !== 'object' ||
          icons.kinds === null ||
          !Object.keys(icons.kinds).length
        )
          throw new Error(
            `${where}.kinds must map quest kinds to { hud, minimap } template files.`,
          );
        for (const [kind, spec] of Object.entries(icons.kinds)) {
          for (const key of ['hud', 'minimap'])
            if (
              !Array.isArray(spec?.[key]) ||
              !spec[key].length ||
              !spec[key].every((file) => typeof file === 'string' && file.endsWith('.png'))
            )
              throw new Error(`${where}.kinds.${kind}.${key} must list PNG template files.`);
          fraction(spec.threshold, `${where}.kinds.${kind}.threshold`);
        }
      }
      if (marker.area !== undefined) {
        const { area } = marker;
        if (typeof area !== 'object' || area === null)
          throw new Error(`${name}.marker.area must be an object.`);
        for (const key of [
          'minRadius',
          'maxResidual',
          'within',
          'maxRadius',
          'minArc',
          'paleMaxRadius',
        ])
          if (area[key] !== undefined && !(area[key] > 0 && area[key] <= 1))
            throw new Error(`${name}.marker.area.${key} must be in (0, 1].`);
        if ((area.min === undefined) !== (area.max === undefined))
          throw new Error(`${name}.marker.area needs both min and max, or neither.`);
        for (const key of ['min', 'max'])
          if (
            area[key] !== undefined &&
            !(
              Array.isArray(area[key]) &&
              area[key].length === 3 &&
              area[key].every((v) => Number.isInteger(v) && v >= 0 && v <= 255)
            )
          )
            throw new Error(`${name}.marker.area.${key} must be [r, g, b] in 0–255.`);
      }
      if (routine.areaArrive !== undefined && !(routine.areaArrive > 0 && routine.areaArrive <= 1))
        throw new Error(`${name}.areaArrive must be in (0, 1].`);
      for (const key of ['hopMs', 'segmentMs', 'dragSettleMs', 'recoverMs', 'detourMs'])
        int(routine, key, name, 0, 5000);
      int(routine, 'areaWaitMs', name, 0, 30_000);
      int(routine, 'areaCircleMs', name, 0, 60_000);
      int(routine, 'areaHopMs', name, 200, 5000);
      int(routine, 'areaLookMs', name, 0, 5000);
      int(routine, 'climbMs', name, 500, 60_000);
      int(routine, 'climbOffDeg', name, 10, 180);
      if (
        routine.climbProgress !== undefined &&
        !(routine.climbProgress > 0 && routine.climbProgress <= 1)
      )
        throw new Error(`${name}.climbProgress must be in (0, 1].`);
      for (const key of ['recoverAfter', 'stuckLimit']) int(routine, key, name, 1, 10);
      int(routine, 'minFrames', name, 1, 60);
      int(routine, 'extendMs', name, 1000, 600_000);
      int(routine, 'extendMetres', name, 1, 1000);
      int(routine, 'extendMaxMs', name, 1000, 1_800_000);
      if (routine.extendMs && !routine.marker?.icons?.distance)
        throw new Error(`${name}.extendMs needs marker.icons.distance to read the quest distance.`);
      int(routine, 'aimTries', name, 0, 5);
      int(routine, 'aimDeg', name, 1, 45);
      if (routine.steer !== undefined && typeof routine.steer !== 'boolean')
        throw new Error(`${name}.steer must be true or false.`);
      if (
        routine.progressText !== undefined &&
        !Object.values(screens).some((s) => s.texts?.some((t) => t.id === routine.progressText))
      )
        throw new Error(`${name}.progressText must name a screen text region.`);
      if (
        routine.aboveText !== undefined &&
        (typeof routine.aboveText !== 'string' || !routine.aboveText || !routine.progressText)
      )
        throw new Error(`${name}.aboveText must be a non-empty string used with progressText.`);
      int(routine, 'progressMetres', name, 1, 1000);
      int(routine, 'sidestepMs', name, 100, 10_000);
      int(routine, 'sidestepTries', name, 1, 10);
      int(routine, 'routeAfter', name, 1, 10);
      int(routine, 'exploreWithin', name, 1, 100);
      if (routine.exploreWithin && !routines.some((r) => r.type === 'explore'))
        throw new Error(`${name}.exploreWithin needs an explore routine.`);
      if (routine.detour !== undefined && !['left', 'right'].includes(routine.detour))
        throw new Error(`${name}.detour must be left or right.`);
      if (routine.detour && !routine.sidestepMs)
        throw new Error(`${name}.detour needs sidestepMs.`);
      if (routine.minimapRotates !== undefined && typeof routine.minimapRotates !== 'boolean')
        throw new Error(`${name}.minimapRotates must be a boolean.`);
      if (routine.distanceBudget !== undefined) {
        const budget = routine.distanceBudget;
        if (
          typeof budget !== 'object' ||
          budget === null ||
          !routine.progressText ||
          !(budget.metresPerSecond > 0)
        )
          throw new Error(
            `${name}.distanceBudget must be an object with metresPerSecond > 0, used with progressText.`,
          );
        int(budget, 'maxMs', `${name}.distanceBudget`, 1000, 600_000);
        if (budget.margin !== undefined && !(budget.margin >= 1 && budget.margin <= 5))
          throw new Error(`${name}.distanceBudget.margin must be between 1 and 5.`);
      }
      if (routine.shift !== undefined) {
        const { shift } = routine;
        if (typeof shift !== 'object' || shift === null)
          throw new Error(`${name}.shift must be an object.`);
        int(shift, 'minShift', `${name}.shift`, 1, 30);
        int(shift, 'range', `${name}.shift`, 2, 60);
      }
      for (const key of ['deflection', 'nearDeflection'])
        if (routine[key] !== undefined && !(routine[key] > 0 && routine[key] <= 1))
          throw new Error(`${name}.${key} must be in (0, 1].`);
      const { screenMarker } = routine;
      if (screenMarker !== undefined) {
        const key = `${name}.screenMarker`;
        const markerSpec = (spec, at) => {
          if (!Array.isArray(spec.rgb) || spec.rgb.length !== 3)
            throw new Error(`${at}.rgb must be three integers 0–255.`);
          if (spec.tolerance === undefined) throw new Error(`${at}.tolerance is required.`);
          const ranges = spec.size === undefined ? ['pixels', 'w', 'h'] : ['pixels', 'size'];
          for (const r of ranges) {
            const v = spec[r];
            if (!Array.isArray(v) || v.length !== 2 || !(v[0] >= 0 && v[1] >= v[0]))
              throw new Error(`${at}.${r} must be [min, max].`);
          }
          if (
            spec.core !== undefined &&
            !(
              spec.core.min >= 0 &&
              spec.core.min <= 255 &&
              spec.core.share > 0 &&
              spec.core.share <= 1
            )
          )
            throw new Error(`${at}.core needs min 0–255 and share in (0, 1].`);
        };
        if (screenMarker.markers === undefined) markerSpec(screenMarker, key);
        else if (!Array.isArray(screenMarker.markers) || !screenMarker.markers.length)
          throw new Error(`${key}.markers must be a non-empty list.`);
        else screenMarker.markers.forEach((spec, i) => markerSpec(spec, `${key}.markers.${i}`));
        if (!(screenMarker.radius > 0)) throw new Error(`${key}.radius must be positive.`);
        (screenMarker.exclude ?? []).forEach((rect, i) =>
          textBox(rect, `${key}.exclude.${i}`, reference),
        );
      }
      for (const [screen, id] of Object.entries(routine.recover ?? {})) {
        screenList([screen], `${name}.recover`);
        button(id, `${name}.recover`);
      }
      if (routine.stuckButton !== undefined) button(routine.stuckButton, `${name}.stuckButton`);
      continue;
    }
    screenList(routine.turnScreens, `${name}.turnScreens`);
    for (const [screen, id] of Object.entries(routine.recover ?? {})) {
      screenList([screen], `${name}.recover`);
      button(id, `${name}.recover`);
    }
    if (routine.stuckButton !== undefined) button(routine.stuckButton, `${name}.stuckButton`);
    if (routine.enemyStop && !enemy) throw new Error(`${name}.enemyStop needs a layout enemy.`);
    if (routine.deflection !== undefined && !(routine.deflection > 0 && routine.deflection <= 1))
      throw new Error(`${name}.deflection must be in (0, 1].`);
    if (routine.forwardDeg !== undefined && !(routine.forwardDeg >= 0 && routine.forwardDeg <= 360))
      throw new Error(`${name}.forwardDeg must be 0–360.`);
    for (const key of ['backstepMs', 'recoverMs']) int(routine, key, name, 0, 5000);
    int(routine, 'hopMs', name, 100, 5000);
    int(routine, 'hops', name, 1, 50);
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
  return loadIconTemplates(validateLayout(parsed), dirname(path));
}

// Navigate markers' icon templates are PNG files next to the layout. Decoded templates are
// attached as non-enumerable `hudTemplates`/`minimapTemplates`, so they stay out of JSON dumps.
export function loadIconTemplates(layout, dir) {
  const cache = new Map();
  const load = (file) => {
    const full = resolve(dir, file);
    if (!cache.has(full)) {
      try {
        cache.set(full, iconTemplate(decodePng(readFileSync(full))));
      } catch (error) {
        throw new Error(`Could not read icon template ${full}: ${error.message}`);
      }
    }
    return cache.get(full);
  };
  for (const routine of layout.routines ?? [])
    for (const spec of Object.values(routine.marker?.icons?.kinds ?? {}))
      for (const [key, files] of [
        ['hudTemplates', spec.hud],
        ['minimapTemplates', spec.minimap],
      ])
        if (!spec[key])
          Object.defineProperty(spec, key, { value: files.map(load), enumerable: false });
  for (const screen of Object.values(layout.screens ?? {}))
    for (const probe of screen.probes ?? [])
      if (probe.template && !probe.icon)
        Object.defineProperty(probe, 'icon', { value: load(probe.template), enumerable: false });
  return layout;
}

// Game HUDs are designed for a canvas of `uiAspect` (width/height): screens wider than that scale
// with height, narrower ones (tablets) with width. Without uiAspect the reference ratio is used.
export function hudScale(screen, reference) {
  const aspect = reference.uiAspect ?? reference.width / reference.height;
  return Math.min(screen.height / reference.height, screen.width / (reference.height * aspect));
}

// Controls keep a fixed (scaled) distance from their anchor edge.
export function resolvePoint(entry, screen, reference) {
  const [ax, ay] = ANCHORS[entry.anchor ?? 'top-left'];
  const scale = hudScale(screen, reference);
  return {
    x: ax * screen.width + (entry.x - ax * reference.width) * scale,
    y: ay * screen.height + (entry.y - ay * reference.height) * scale,
    scale,
  };
}

export function resolveCamera(camera, screen, reference) {
  const { x, y, scale } = resolvePoint(camera, screen, reference);
  return {
    x: Math.round(x),
    y: Math.round(y),
    degreesPerPixel: camera.degreesPerPixel / scale,
    maxDrag: camera.maxDrag * scale,
    deadzone: (camera.deadzone ?? 0) * scale,
    ...(camera.curve && { curve: camera.curve.map(([px, deg]) => [px * scale, deg]) }),
  };
}

// The enemy HP bar detector on this screen: search bounds plus the reference-to-screen scale.
export function resolveEnemy(enemy, screen, reference) {
  return {
    ...enemy,
    bounds: resolveRect(enemy, screen, reference),
    scale: hudScale(screen, reference),
  };
}

// One sentence for Jev about visible enemies; the widest bar is taken as the nearest. Without a
// bar, OCR-confirmed level labels (`labels`) mean enemies too far away to show one.
export function describeEnemies(bars, enemy, screen, labels = [], arrow = null, reached = false) {
  const sideOf = (x) => {
    const dx = (x - screen.width / 2) / screen.width;
    return dx < -0.12 ? 'to the left' : dx > 0.12 ? 'to the right' : 'ahead';
  };
  if (!bars.length && labels.length)
    return `No enemy HP bar 敌人血条 is visible, but ${labels.length} distant enemy level label${labels.length > 1 ? 's' : ''} (${labels[0].text}) ${labels.length > 1 ? 'are' : 'is'} visible ${sideOf(labels[0].x)}: an enemy is far away, not within fighting range.`;
  if (!bars.length && arrow) {
    const d = arrow.deg;
    const where =
      Math.abs(d) > 135 ? 'behind' : d < -45 ? 'to the right' : d > 45 ? 'to the left' : 'ahead';
    return `No enemy HP bar 敌人血条 is in view, but a red off-screen enemy arrow shows an enemy ${where}, outside the view (it may be attacking).`;
  }
  if (!bars.length) return 'No enemy HP bar 敌人血条 is visible.';
  const [nearest] = bars;
  const side = sideOf(nearest.x);
  const close = reached || nearest.w >= enemy.nearWidth * enemy.scale;
  return `${bars.length} enemy HP bar${bars.length > 1 ? 's' : ''} 敌人血条 visible; the nearest is ${side} and ${close ? `within fighting range${reached ? ' (the last approach reached it)' : ''}` : 'not yet within fighting range'}.`;
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

function sample(image, screen, x, y, radius = 1) {
  const ix = Math.round((x * image.width) / screen.width),
    iy = Math.round((y * image.height) / screen.height);
  const sum = [0, 0, 0];
  let n = 0;
  for (let dy = -radius; dy <= radius; dy++)
    for (let dx = -radius; dx <= radius; dx++) {
      const px = ix + dx,
        py = iy + dy;
      if (px < 0 || py < 0 || px >= image.width || py >= image.height) continue;
      rgbAt(image, px, py).forEach((v, i) => (sum[i] += v));
      n++;
    }
  return n ? sum.map((v) => Math.round(v / n)) : null;
}

// The first screen whose probes all match wins; screens without probes are never detected.
// `drift` probes mark a floating panel (e.g. prompt lists) whose position varies slightly between
// devices: they are sampled at one pixel and must all match at one shared horizontal offset
// within the screen's `drift.x` (reference px). Fixed probes are checked in place.
export function detectScreen(image, screen, layout) {
  const results = {};
  let detected = null;
  const check = (probe, dx, radius) => {
    const { x, y, scale } = resolvePoint(probe, screen, layout.reference);
    if (probe.template) {
      if (!probe.icon)
        throw new Error(`Template ${probe.template} is not loaded (use loadLayout).`);
      const k = (scale * image.width) / screen.width;
      const ix = (x * image.width) / screen.width,
        iy = (y * image.height) / screen.height;
      const best = bestIconAt(image, Math.round(ix), Math.round(iy), probe.icon, {
        k,
        search: Math.round((probe.search ?? 6) * k),
      });
      const score = Math.round(best.s * 1000) / 1000;
      return {
        x: Math.round(x),
        y: Math.round(y),
        template: probe.template,
        score,
        matched: score >= (probe.min ?? 0.6),
      };
    }
    const observed = sample(image, screen, x + dx, y, radius);
    const tolerance = probe.tolerance ?? 40;
    const matched =
      observed !== null && observed.every((v, i) => Math.abs(v - probe.rgb[i]) <= tolerance);
    return { x: Math.round(x + dx), y: Math.round(y), expected: probe.rgb, observed, matched };
  };
  const scale = hudScale(screen, layout.reference);
  const step = screen.width / image.width;
  for (const [id, definition] of Object.entries(layout.screens)) {
    const all = definition.probes ?? [];
    const fixed = all.filter((p) => !p.drift).map((p) => check(p, 0, 1));
    const floating = all.filter((p) => p.drift);
    let drifted = [],
      offset;
    if (floating.length) {
      const limit = (definition.drift?.x ?? 0) * scale;
      const offsets = [0];
      for (let d = step; d <= limit + 1e-9; d += step) offsets.push(d, -d);
      for (const dx of offsets) {
        const attempt = floating.map((p) => check(p, dx, 0));
        if (!drifted.length) drifted = attempt;
        if (attempt.every((p) => p.matched)) {
          drifted = attempt;
          offset = Math.round(dx);
          break;
        }
      }
    }
    const probes = [...fixed, ...drifted];
    const matched = probes.length > 0 && probes.every((p) => p.matched);
    results[id] = { matched, probes, ...(offset !== undefined ? { offset } : {}) };
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
  for (const region of layout.statusTexts ?? [])
    if (region.screens.includes(detected))
      regions.push({
        key: `status:${region.id}`,
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
        routine.type === 'explore' || routine.type === 'navigate' || routine.type === 'approach'
          ? joystickBounds()
          : buttonBounds(
              routine.type === 'dialogue'
                ? routine.button
                : routine.type === 'teleport' || routine.type === 'track_quest'
                  ? routine.open
                  : routine.attack,
            ),
    }));
}

// Two OCR reads of one text: OCR drops or swaps a few characters of a line it read before (e.g.
// 寻找位… for 寻找下一位…), so reads sharing 80% of their characters in order are the same.
function sameRead(a, b) {
  if (a === b) return true;
  [a, b] = [[...a], [...b]];
  const row = new Array(b.length + 1).fill(0);
  for (const ca of a) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j++) {
      const up = row[j];
      row[j] = ca === b[j - 1] ? diagonal + 1 : Math.max(row[j], row[j - 1]);
      diagonal = up;
    }
  }
  return row[b.length] >= 0.8 * Math.max(a.length, b.length);
}

// The last navigate found no marker on screen while the HUD put the quest within `exploreWithin`.
function nearNoMarker(last, layout) {
  const within = layout.routines?.find(
    (r) => r.type === 'navigate' && r.exploreWithin,
  )?.exploreWithin;
  const result = last?.routine;
  const routine = result && layout.routines.find((r) => r.id === result.routine);
  return Boolean(
    within &&
    routine?.type === 'navigate' &&
    result.status === 'no_marker' &&
    Number.isFinite(result.questMetres) &&
    result.questMetres <= within,
  );
}

// Add code-owned fixed controls to an observation; Jev still chooses whether and which to tap.
// OCR texts (keyed `button:<id>` or `screen:<id>`) become element text Jev can read.
export function layoutObservation(
  base,
  image,
  layout,
  {
    last,
    texts = {},
    ocr,
    routines = false,
    enemyLabels = [],
    memory,
    blocked,
    farQuest,
    downed,
    healFailed,
    landed,
  } = {},
) {
  const { screen: detected, results } = detectScreen(image, base.screen, layout);
  let description = detected ? layout.screens[detected].description || detected : undefined;
  let threat;
  if (detected && layout.enemy?.screens?.includes(detected)) {
    const enemy = resolveEnemy(layout.enemy, base.screen, layout.reference);
    const bars = enemyBars(image, enemy.bounds, base.screen, enemy, enemy.scale);
    const arrow = !bars.length && enemyArrow(image, base.screen, enemy, enemy.scale);
    // Bars flicker in width, so a code-verified `near` from the last approach wins over this frame.
    const reached = last?.routine?.status === 'near';
    if (bars.length && (reached || bars[0].w >= enemy.nearWidth * enemy.scale))
      threat = 'enemy_near';
    description = `${description} ${describeEnemies(bars, enemy, base.screen, enemyLabels, arrow, reached)}`;
    // Code-verified search outcome: without it Jev repeats a search that already turned a full circle.
    if (
      !bars.length &&
      !enemyLabels.length &&
      !arrow &&
      last?.routine?.status === 'no_enemy' &&
      last.routine.scans > 0
    )
      description = `${description} The last enemy search turned a full circle here and found no enemy; move somewhere else before searching again.`;
  }
  const lastRoutine =
    last?.routine && layout.routines?.find((routine) => routine.id === last.routine.routine);
  if (detected && last?.routine?.status === 'attacked' && last.routine.health) {
    const { from, to } = last.routine.health;
    const pct = (value) => `${Math.round(value * 100)}%`;
    threat = 'attacked';
    description = `${description} The last ${lastRoutine?.label ?? last.routine.routine} stopped because code measured the active character's health falling (${pct(from)} → ${pct(to)}): enemies are attacking nearby, possibly out of view. Fight back now with combat; its attacks turn towards the nearest enemy.`;
  }
  if (detected && nearNoMarker(last, layout)) {
    const navigate = layout.routines.find((r) => r.type === 'navigate' && r.exploreWithin);
    const explore = layout.routines.find((r) => r.type === 'explore');
    description = `${description} The last ${lastRoutine?.label ?? 'walk'} found no quest marker on screen although the quest is only ${last.routine.questMetres}m away: it is hidden nearby. Code makes the next ${navigate.label} run ${explore.label} instead, to look around for it.`;
  }
  if (detected && lastRoutine?.type === 'teleport') {
    const { status, target } = last.routine;
    const healing = lastRoutine.id === 'heal';
    const sentence = healing
      ? {
          teleported: `The last healing trip was code-verified: it arrived at ${target}; wait for the Statue of The Seven to restore health.`,
          unverified: `The last healing trip tapped 传送 at ${target}, but code could not verify that the map position changed.`,
          no_quest:
            'The last healing trip found no visible unlocked Statue of The Seven at the current map zoom; press BACK and continue another activity.',
          no_waypoint:
            'The last healing trip found a Statue marker but no unlocked matching teleport point.',
          no_teleport_button:
            'The last healing trip could not open a 七天神像 teleport panel; press BACK and continue another activity.',
        }[status]
      : {
          teleported: `The last teleport was code-verified: it arrived at ${target} and the minimap changed.`,
          unverified: `The last teleport tapped 传送 at ${target} and the world came back, but the minimap did not change; it may not have moved.`,
          no_quest:
            'The last teleport found no tracked quest on the world map; it may be in another region. Press BACK, then use Track quest 追踪任务: it tracks the quest again so the game opens the map on it, and teleport from there.',
          no_waypoint:
            'The last teleport found no unlocked teleport waypoint near the tracked quest; press BACK and walk instead.',
          no_teleport_button:
            'The last teleport could not open a teleport panel at the waypoint nearest the quest; press BACK and walk instead.',
          quest_near: `The last teleport did not teleport: code found the tracked quest close to you (${last.routine.questMetres !== undefined ? `${last.routine.questMetres}m away` : 'near you on the world map'}). ${last.routine.closed ? 'Walk to it with navigate.' : 'Press BACK, then walk to it with navigate.'}`,
        }[status];
    // Walking is blocked: a teleport panel that did not open is retried at the next nearest point.
    const retry =
      !healing &&
      blocked &&
      status === 'no_teleport_button' &&
      `The last teleport could not open a teleport panel at ${last.routine.skipped ? 'that' : 'the nearest'} waypoint. Walking to the quest is blocked, so use ${lastRoutine.label} again: code tries the next nearest teleport point.`;
    if (retry || sentence) description = `${description} ${retry || sentence}`;
  }
  // A teleport that found no quest on the map: the quest is in another region. The fact must
  // outlast the BACK that closes the map, until track_quest re-tracks it.
  if (last?.routine && lastRoutine && last.routine.status !== 'started') {
    if (lastRoutine.type === 'track_quest') farQuest = undefined;
    else if (lastRoutine.type === 'teleport' && lastRoutine.id !== 'heal')
      farQuest = last.routine.status === 'no_quest' || undefined;
    // Downed teammates with no revive food stay downed until a Statue of The Seven heals them.
    if (lastRoutine.type === 'combat' && last.routine.noFood) downed = true;
    else if (
      lastRoutine.type === 'teleport' &&
      lastRoutine.id === 'heal' &&
      ['teleported', 'unverified'].includes(last.routine.status)
    )
      downed = undefined;
    // Failed heals: the map shows no usable Statue from here, and retrying here fails the same way.
    if (lastRoutine.type === 'teleport' && healFailed?.source !== last.routine) {
      const moved = ['teleported', 'unverified'].includes(last.routine.status);
      if (lastRoutine.id === 'heal')
        healFailed = moved
          ? undefined
          : Object.defineProperty({ count: (healFailed?.count ?? 0) + 1 }, 'source', {
              value: last.routine,
            });
      else if (moved) healFailed = undefined;
    }
  }
  const tracker = layout.routines?.find((r) => r.type === 'track_quest');
  if (tracker && farQuest && detected && lastRoutine?.type !== 'teleport')
    description = `${description} Code found no tracked quest on the world map at the last teleport: the quest is in another region, and teleport will not find it until the quest is tracked again with ${tracker.label}.`;
  const healer = layout.routines?.find((r) => r.type === 'teleport' && r.id === 'heal');
  if (healer && downed && detected)
    description = `${description} The last fight left teammates downed and had no food left to revive them; they stay downed until ${healer.label} restores the party.`;
  if (healer && healFailed && detected && lastRoutine?.id !== 'heal')
    description = `${description} ${healer.label} failed ${healFailed.count === 1 ? 'once' : `${healFailed.count} times in a row`} from here (no usable Statue of The Seven on the map around you); it fails the same way until a teleport moves you elsewhere.`;
  if (detected && lastRoutine?.type === 'track_quest') {
    const { status, quest } = last.routine;
    const named = quest ? ` (${quest})` : '';
    const sentence = {
      tracked: `The last quest tracking was code-verified: it tracked the selected quest${named} and the HUD now shows its distance.`,
      tracked_far: `The last quest tracking ${last.routine.retracked ? 'tracked the quest again' : 'tracked the selected quest'}${named}; it is far away, and the world map is now open on it. Teleport there now.`,
      already_tracked: `The last quest tracking found a quest already tracked${named}; nothing was changed.`,
      unverified: `The last quest tracking tapped 追踪目标${named}, but the HUD shows no quest distance yet.`,
      no_quest_log: 'The last quest tracking could not open the quest log 任务.',
      no_track_button: `The last quest tracking found no 追踪 button for the selected quest${named}.`,
    }[status];
    if (sentence) description = `${description} ${sentence}`;
  }
  const hasProbes = Object.values(layout.screens).some((s) => s.probes?.length);
  const previousAction = lastActionEffect(last, detected || 'unknown', layout);
  // `match` rejects OCR noise from busy backgrounds; `requires` keeps a region only with another.
  const regions = detected
    ? [
        ...(layout.screens[detected].texts ?? []).map((region) => ({
          ...region,
          textKey: `screen:${region.id}`,
        })),
        ...(layout.statusTexts ?? [])
          .filter((region) => region.screens.includes(detected))
          .map((region) => ({ ...region, textKey: `status:${region.id}` })),
      ]
    : [];
  const accepted = new Map();
  for (const region of regions) {
    let text = texts[region.textKey];
    // `fix` corrects known OCR confusions (e.g. the digit 0 read as "o") before matching.
    for (const [pattern, replacement] of Object.entries(region.fix ?? {}))
      text = text?.replace(new RegExp(pattern, 'gu'), replacement);
    if (text && (region.match === undefined || new RegExp(region.match, 'u').test(text)))
      accepted.set(region.id, text);
  }
  const screenTexts = regions.flatMap((region) => {
    const text = accepted.get(region.id);
    const bounds =
      text &&
      (region.requires === undefined || accepted.has(region.requires)) &&
      resolveRect(region, base.screen, layout.reference);
    if (!bounds) return [];
    // `remember` keeps the last read across observations (e.g. while dialogue hides the HUD), so
    // a code-read change such as quest progress is stated instead of left for Jev to guess.
    if (region.remember && memory) {
      const before = memory.get(region.id);
      const plain = (value) => value.replace(/[\s\p{P}]/gu, '');
      if (before !== undefined && !sameRead(plain(before.text), plain(text)))
        memory.set(region.id, { text, from: before.text });
      else if (before === undefined) memory.set(region.id, { text });
      const { from } = memory.get(region.id);
      if (from !== undefined)
        description = `${description} Code read that ${region.label} last changed from "${from}" to "${memory.get(region.id).text}".`;
    }
    return [virtualElement(`layout-text.${region.id}`, { text, label: region.label, bounds })];
  });
  // Code-measured walking progress: a navigate that timed out or got stuck without the quest
  // distance shrinking means the path is blocked (water, cliffs, roofs), which Jev cannot see.
  const navigate = (layout.routines ?? []).find((r) => r.type === 'navigate' && r.progressText);
  // Teleport withheld by the quest lock (see below); a heal trip or a stuck walk opens it once.
  let withheld = false;
  if (detected && navigate) {
    const read = accepted.get(navigate.progressText);
    const metres =
      read === undefined ? undefined : Number(hudDistance(read).match(/(\d+)\s*m/i)?.[1]);
    const shown = (m) => (Number.isFinite(m) ? `${m}m` : 'unreadable');
    const teleporter = (layout.routines ?? []).find(
      (r) => r.type === 'teleport' && r.id !== 'heal',
    );
    // A teleport is a step toward the main quest (the tracked quest title, `questText`). Once
    // another teleport landed no closer, or walking got closer than the landing, teleporting
    // again only goes back: code withholds it for as long as the main quest stays the same.
    let lockNote = '';
    let rescueNote = '';
    if (teleporter) {
      const margin = teleporter.staleMetres ?? 20;
      const titleId = teleporter.questText;
      const quest = titleId && (accepted.get(titleId) ?? memory?.get(titleId)?.text);
      const plain = (value) => value.replace(/[\s\p{P}]/gu, '');
      if (landed && quest && landed.quest && !sameRead(plain(landed.quest), plain(quest)))
        landed = undefined;
      if (landed && quest && !landed.quest) landed.quest = quest;
      // A healing trip keeps the record, but the statue is elsewhere: one teleport may go back.
      const healed =
        lastRoutine?.type === 'teleport' &&
        lastRoutine.id !== teleporter.id &&
        ['teleported', 'unverified'].includes(last.routine.status);
      if (healed) {
        if (landed && landed.source !== last.routine)
          landed = Object.defineProperties(
            { ...landed, away: true },
            { source: { value: last.routine } },
          );
      } else if (
        lastRoutine?.id === teleporter.id &&
        ['teleported', 'unverified'].includes(last.routine.status) &&
        Number.isFinite(metres) &&
        landed?.source !== last.routine &&
        landed?.lock
      ) {
        // A teleport allowed under the lock (back from healing, or out of a stuck walk) landed:
        // the lock holds again. The stuck-walk pass is used once per quest.
        const { away, ...kept } = landed;
        landed = Object.defineProperties(
          { ...kept, ...(away ? {} : { rescued: true }) },
          { source: { value: last.routine } },
        );
      } else if (
        lastRoutine?.id === teleporter.id &&
        ['teleported', 'unverified'].includes(last.routine.status) &&
        Number.isFinite(metres) &&
        landed?.source !== last.routine
      ) {
        const stale = Number.isFinite(landed?.metres) && metres >= landed.metres - margin;
        landed = Object.defineProperties(
          {
            metres,
            ...(quest ? { quest } : {}),
            ...(stale ? { lock: 'stale', from: landed.metres } : {}),
          },
          { source: { value: last.routine } },
        );
      } else if (
        landed &&
        !landed.lock &&
        !landed.away &&
        Number.isFinite(metres) &&
        metres < landed.metres - margin
      )
        Object.assign(landed, { lock: 'closer', to: metres });
      if (landed?.lock && landed.away)
        lockNote = ` The last trip healed at a statue away from the tracked quest, so ${teleporter.label} is available once to go back; after it lands, teleporting is unavailable again for this quest.`;
      else if (landed?.lock) {
        const why =
          landed.lock === 'stale'
            ? `the last ${teleporter.label} landed no closer than the one before (${shown(landed.from)} → ${shown(landed.metres)}): this is already the nearest teleport point`
            : `walking already brought the quest closer (${shown(landed.metres)} at the teleport landing → ${shown(landed.to)}), so teleporting again would only go back`;
        const until = landed.quest
          ? `until the tracked quest "${landed.quest}" changes`
          : 'until the tracked quest changes';
        lockNote = ` Code measured that ${why}. ${teleporter.label} is unavailable ${until}; walk to the quest from here, even when it is far.`;
        rescueNote = ` Teleporting is locked for this quest (${why}), but walking is stuck, so ${teleporter.label} is available once more; after it lands, teleporting is unavailable again ${until}.`;
      }
    }
    if (lastRoutine?.type === 'teleport') {
      // Away from the blocked spot: walk again. With no teleport point left, walking is all there is.
      const { status, tried } = last.routine;
      if (['teleported', 'unverified', 'no_waypoint'].includes(status)) blocked = undefined;
      // No panel opened at the nearest points: the next teleport skips the ones already tried.
      else if (
        blocked &&
        status === 'no_teleport_button' &&
        lastRoutine.id !== 'heal' &&
        blocked.source !== last.routine
      )
        blocked = Object.defineProperty(
          { ...blocked, skip: Math.max((blocked.skip ?? 0) + 1, tried ?? 0) },
          'source',
          { value: last.routine },
        );
    } else if (lastRoutine?.type === 'navigate') {
      const { status, fromMetres } = last.routine;
      const failed = status === 'timeout' || status === 'stuck';
      const count = (blocked?.count ?? 0) + 1;
      const mark = (value) => Object.defineProperty(value, 'source', { value: last.routine });
      // The same routine result is seen by every observation until the next action.
      if (blocked?.source === last.routine) {
        // Already counted.
      } else if (status === 'arrived') blocked = undefined;
      else if (fromMetres !== undefined && Number.isFinite(metres)) {
        const stalled = failed && metres > fromMetres - (navigate.progressMetres ?? 5);
        blocked = stalled ? mark({ ...blocked, from: fromMetres, to: metres, count }) : undefined;
      } else if (failed) {
        // The HUD distance is unreadable (often while climbing or swimming): a failed walk shows
        // no measured progress, so it counts as blocked too.
        const from = fromMetres ?? blocked?.from;
        const to = Number.isFinite(metres) ? metres : blocked?.to;
        blocked = mark({ ...blocked, from, to, count });
      }
    }
    // Walking stuck under the lock: one more teleport for this quest, then the lock holds again.
    const rescue = Boolean(
      landed?.lock &&
      !landed.away &&
      !landed.rescued &&
      blocked?.count >= (navigate.routeAfter ?? 2),
    );
    withheld = Boolean(landed?.lock && !landed.away && !rescue);
    description = `${description}${rescue ? rescueNote : lockNote}`;
    const tries = navigate.sidestepMs ? (navigate.sidestepTries ?? 2) : 0;
    const detours = (layout.routines ?? []).filter((r) => r.type === 'navigate' && r.detour);
    if (blocked) {
      const teleport = (layout.routines ?? []).find(
        (r) => r.type === 'teleport' && r.id !== 'heal',
      );
      const times = blocked.count === 1 ? 'once' : `${blocked.count} times in a row`;
      const next = detours.length
        ? `${detours.map((r) => `${r.label} first walks ${r.detour} for about ${Math.round(r.sidestepMs / 1000)} seconds, then heads for the marker`).join('; ')}; ${navigate.label} heads straight for the marker again.`
        : blocked.count <= tries
          ? `The next ${navigate.label} first walks to the ${blocked.count % 2 ? 'left' : 'right'} for a moment to get around it, then heads for the marker again.`
          : `The next ${navigate.label} heads straight for the marker again; its sidesteps are used up.`;
      const routed = (layout.routines ?? []).find((r) => r.type === 'navigate' && r.route);
      const route = !routed
        ? ''
        : navigate.routeAfter && blocked.count >= navigate.routeAfter
          ? ` Because of that, code makes the next ${navigate.label}${detours.length ? ` or ${detours.map((r) => r.label).join(' or ')}` : ''} run ${routed.label} instead: it plans a way along the open ground shown on the minimap.`
          : ` ${routed.label} plans a way along the open ground shown on the minimap instead of heading straight for the marker.`;
      const skipped =
        teleport && !withheld
          ? ` ${teleport.label} would skip its "quest is close" check${blocked.skip ? ` and the ${blocked.skip} nearest teleport point${blocked.skip === 1 ? '' : 's'} already tried` : ''}.`
          : '';
      description = `${description} Code measured that walking to the quest made no progress ${times} (${shown(blocked.from)} → ${shown(blocked.to)}): something is in the way. ${next}${route}${skipped}`;
    }
    // Code compares the distance with teleport's near threshold, so Jev reads a named bucket.
    const far = (layout.routines ?? []).find(
      (r) => r.type === 'teleport' && r.id !== 'heal' && r.nearMeters,
    )?.nearMeters;
    if (far && regions.some((r) => r.id === navigate.progressText)) {
      const where = read && hudDistance(read) !== read ? ` (${read.replace(/\s/gu, '')})` : '';
      description = `${description} ${
        Number.isFinite(metres)
          ? `Code read the tracked quest as ${metres > far ? `far away: ${metres}m, more than ${far}m${withheld ? ' (teleport is unavailable for this quest: keep walking)' : ''}` : `close: ${metres}m, ${far}m or less`}${where}.`
          : 'Code read no quest distance on the HUD.'
      }`;
    }
  }
  // Status texts such as health "743/7301": code compares the ratio and names it low.
  for (const region of layout.statusTexts ?? []) {
    const match = region.low !== undefined && accepted.get(region.id)?.match(/(\d+)\s*\/\s*(\d+)/);
    if (!match || !(Number(match[2]) > 0)) continue;
    const ratio = Number(match[1]) / Number(match[2]);
    if (ratio <= region.low)
      description = `${description} Code read ${region.label} as low: ${match[1]}/${match[2]}, ${Math.round(region.low * 100)}% or less.`;
  }
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
    ...(routines ? layoutRoutines(layout, base.screen, detected) : [])
      // Detours only make sense once code measured the walk as blocked.
      .filter(({ routine }) => !routine.detour || blocked)
      .filter(({ routine }) => !(withheld && routine.type === 'teleport' && routine.id !== 'heal'))
      .map(({ routine, bounds }) =>
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
      ...(detected && layout.playbook?.length ? { playbook: layout.playbook } : {}),
      signature: createHash('sha256')
        .update(
          JSON.stringify([
            visual.screen,
            elements.filter((e) => e.id.startsWith('layout')).map((e) => [e.id, e.text]),
          ]),
        )
        .digest('hex'),
      ...(previousAction ? { previousAction } : {}),
      ...(blocked ? { blocked } : {}),
      ...(farQuest ? { farQuest } : {}),
      ...(downed ? { downed } : {}),
      ...(healFailed ? { healFailed } : {}),
      ...(landed ? { landed } : {}),
      ...(threat ? { threat } : {}),
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
  let blocked;
  let farQuest;
  let downed;
  let healFailed;
  let landed;
  const memory = new Map();
  // Devices may offer faster decoded frames (ADB_CAPTURE=raw); otherwise decode the PNG.
  const capture = async () => {
    const capturedAt = Date.now();
    const image =
      typeof device.frame === 'function'
        ? await device.frame()
        : decodePng(await device.screenshot());
    return Object.assign(image, { capturedAt });
  };
  // Keep the pixels with the observation for frame recording; non-enumerable stays out of traces.
  const withFrame = (observation, image) => {
    device.debug?.frame({
      image,
      capturedAt: image.capturedAt,
      screen: observation.layout?.screen ?? null,
      source: 'observe',
    });
    return Object.defineProperty(observation, 'frame', {
      value: { image, capturedAt: image.capturedAt },
      enumerable: false,
    });
  };
  const readText =
    recognizer && (async (image, box) => (await recognizer.recognize(image, box))?.text ?? '');
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
    let enemyLabels = [];
    if (recognizer && layout.enemy?.levelText && layout.enemy.screens?.includes(detected)) {
      try {
        const enemy = resolveEnemy(layout.enemy, base.screen, layout.reference);
        ({ labels: enemyLabels } = await findEnemies(image, base.screen, enemy, readText));
      } catch {
        enemyLabels = [];
      }
    }
    const observation = layoutObservation(base, image, layout, {
      last,
      texts,
      ocr,
      enemyLabels,
      memory,
      blocked,
      farQuest,
      downed,
      healFailed,
      landed,
      routines: typeof device.touch === 'function',
    });
    blocked = observation.layout.blocked;
    farQuest = observation.layout.farQuest;
    downed = observation.layout.downed;
    healFailed = observation.layout.healFailed;
    landed = observation.layout.landed;
    return observation;
  };
  const observeOnce = async () => {
    // ADB: game surfaces often break uiautomator, so read the foreground package and pixels only.
    if (typeof device.foregroundPackage === 'function') {
      const packageName = await device.foregroundPackage();
      if (!packages.has(packageName)) return baseObserve();
      const image = await capture();
      return withFrame(
        await observeLayout(screenOnlyObservation(device.deviceId, packageName, image), image),
        image,
      );
    }
    const base = await baseObserve();
    if (!packages.has(base.phone.packageName)) return base;
    const image = await capture();
    return withFrame(await observeLayout(base, image), image);
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
      const hold =
        action?.type === 'tap-element' &&
        layout.buttons.find((b) => `layout.${b.id}` === action.elementId)?.holdMs;
      try {
        let result;
        // Some game buttons ignore a plain tap (e.g. 复苏 on the defeat screen) and need a press.
        if (hold) {
          if (!options?.expected)
            throw new Error('Element taps require their original observation.');
          const current = await device.observe();
          assertFresh(current, options.expected, action, options.maxAgeMs);
          const { left, top, right, bottom } = current.elements.find(
            (e) => e.id === action.elementId,
          ).bounds;
          const x = Math.floor((left + right) / 2),
            y = Math.floor((top + bottom) / 2);
          result = await baseAct({
            type: 'swipe',
            startX: x,
            startY: y,
            endX: x,
            endY: y,
            duration: hold,
          });
        } else result = await baseAct(action, options);
        const tapped =
          device.debug &&
          action?.type === 'tap-element' &&
          options?.expected?.elements?.find((e) => e.id === action.elementId);
        if (tapped?.bounds) {
          const { left, top, right, bottom } = tapped.bounds;
          device.debug.event({
            type: 'touch',
            phase: 'tap',
            routine: 'jev',
            x: Math.floor((left + right) / 2),
            y: Math.floor((top + bottom) / 2),
            label: tapped.text || tapped.label || action.elementId,
          });
        }
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
    let routine = layout.routines.find((r) => `layout-routine.${r.id}` === action.elementId);
    if (!routine || typeof device.touch !== 'function')
      throw new Error('Routine is not available.');
    // Walks blocked `routeAfter` times in a row: code plans a minimap route instead of a straight walk.
    const autoRoute =
      routine.type === 'navigate' &&
      !routine.route &&
      routine.routeAfter &&
      blocked &&
      blocked.count >= routine.routeAfter
        ? layout.routines.find((r) => r.type === 'navigate' && r.route)
        : undefined;
    if (autoRoute) routine = autoRoute;
    // The quest is close but its marker is off screen: walking at it again does nothing, so code
    // explores nearby for the talk prompt instead.
    const autoExplore =
      !autoRoute && routine.type === 'navigate' && nearNoMarker(last, layout)
        ? layout.routines.find((r) => r.type === 'explore')
        : undefined;
    if (autoExplore) routine = autoExplore;
    const dims = current.screen;
    last = { action, screen, routine: { routine: routine.id, status: 'started' } };
    const healthBar = layout.healthBar && {
      ...layout.healthBar,
      bounds: resolveRect(layout.healthBar, dims, layout.reference),
    };
    // Last visible HP bar fill in this routine: a drop of `minDrop` between frames is damage.
    let health = null;
    const progress =
      routine.type === 'navigate' &&
      routine.progressText &&
      options.expected.elements?.find((e) => e.id === `layout-text.${routine.progressText}`)?.text;
    const fromMetres = progress ? Number(hudDistance(progress).match(/(\d+)\s*m/i)?.[1]) : NaN;
    // A far quest needs a longer walk: the time limit grows with the HUD distance at the start.
    const budget = routine.distanceBudget;
    if (budget && Number.isFinite(fromMetres)) {
      const ms = Math.round((fromMetres / budget.metresPerSecond) * (budget.margin ?? 1.2) * 1000);
      const maxMs = Math.min(Math.max(ms, routine.maxMs ?? 0), budget.maxMs ?? Infinity);
      if (maxMs > (routine.maxMs ?? 0)) routine = { ...routine, maxMs };
    }
    // The HUD says the quest is above (原神: 高处): climbing is the way there, not an obstacle.
    const above = Boolean(progress && routine.aboveText && progress.includes(routine.aboveText));
    // A walk measured as blocked lets teleport skip its "quest is close, walk instead" checks.
    // A teleport that found no quest on the map: track_quest re-tracks even with a HUD distance.
    const force =
      (routine.type === 'teleport' && Boolean(blocked)) ||
      (routine.type === 'track_quest' && Boolean(farQuest));
    // A walk measured as blocked: Jev picks a detour side when the layout offers detours;
    // otherwise the next navigate first sidesteps, alternating left and right.
    const hasDetours = layout.routines.some((r) => r.type === 'navigate' && r.detour);
    const sidestep =
      routine.type !== 'navigate'
        ? undefined
        : routine.detour
          ? routine.detour
          : !hasDetours &&
              routine.sidestepMs &&
              blocked &&
              blocked.count <= (routine.sidestepTries ?? 2)
            ? blocked.count % 2
              ? 'left'
              : 'right'
            : undefined;
    const skip = routine.type === 'teleport' && blocked ? (blocked.skip ?? 0) : 0;
    const joystick = layout.joystick && resolvePoint(layout.joystick, dims, layout.reference);
    // Debug viewers see which button each routine touch pressed (combat: skill, attack, burst...).
    const debug = device.debug;
    let pressed;
    if (debug) {
      pressed = new Map();
      for (const button of layout.buttons) {
        const b = resolveRect(button, dims, layout.reference);
        if (!b) continue;
        const key = `${Math.floor((b.left + b.right) / 2)},${Math.floor((b.top + b.bottom) / 2)}`;
        if (!pressed.has(key)) pressed.set(key, button);
      }
      debug.event({ type: 'routine_start', routine: routine.id, kind: routine.type });
    }
    // Every touch phase goes out with its screen point, so viewers can draw presses and drags.
    let gesture;
    const touch = (event, px, py) => {
      if (debug) {
        if (event === 'down') {
          const button = pressed.get(`${px},${py}`);
          const nearStick =
            joystick && Math.hypot(px - joystick.x, py - joystick.y) <= layout.joystick.radius * 2;
          gesture = button
            ? { button: button.id, label: button.label }
            : { target: nearStick ? 'joystick' : 'drag' };
        }
        debug.event({ type: 'touch', phase: event, routine: routine.id, x: px, y: py, ...gesture });
      }
      return device.touch(event, px, py);
    };
    const result = await ROUTINES[routine.type]({
      routine,
      sidestep,
      above,
      ...(skip ? { skip } : {}),
      screen: dims,
      joystick: joystick && {
        x: Math.round(joystick.x),
        y: Math.round(joystick.y),
        radius: layout.joystick.radius * joystick.scale,
      },
      minimap: layout.minimap && resolveRect(layout.minimap, dims, layout.reference),
      camera: layout.camera && resolveCamera(layout.camera, dims, layout.reference),
      enemy: layout.enemy && resolveEnemy(layout.enemy, dims, layout.reference),
      readText: readText || undefined,
      buttonCenter: (id) => {
        const b = resolveRect(
          layout.buttons.find((button) => button.id === id),
          dims,
          layout.reference,
        );
        return { x: Math.floor((b.left + b.right) / 2), y: Math.floor((b.top + b.bottom) / 2) };
      },
      hudScale: hudScale(dims, layout.reference),
      rect: (entry) => resolveRect(entry, dims, layout.reference),
      frame: async () => {
        const image = await capture();
        const detected = detectScreen(image, dims, layout).screen;
        if (!healthBar) {
          debug?.frame({
            image,
            capturedAt: image.capturedAt,
            screen: detected ?? 'unknown',
            source: routine.id,
          });
          return { image, screen: detected };
        }
        const fill = healthBar.screens.includes(detected)
          ? healthFill(image, dims, healthBar)
          : null;
        const frame = { image, screen: detected, health: fill };
        if (fill !== null) {
          if (health !== null && health - fill >= (healthBar.minDrop ?? 0.03))
            frame.damaged = { from: round2(health), to: round2(fill) };
          health = fill;
        }
        debug?.frame({
          image,
          capturedAt: image.capturedAt,
          screen: detected ?? 'unknown',
          source: routine.id,
          health: fill === null ? null : round2(fill),
          ...(frame.damaged ? { damaged: frame.damaged } : {}),
        });
        return frame;
      },
      touch,
      back: baseAct && (() => baseAct({ type: 'global', name: 'back' })),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: () => performance.now(),
      random: device.random ?? Math.random,
      ...(force ? { force } : {}),
      ...(routine.track
        ? { track: layout.routines.find((r) => r.id === routine.track && r.type === 'track_quest') }
        : {}),
    });
    last = {
      action,
      screen,
      routine: {
        ...result,
        ...(Number.isFinite(fromMetres) ? { fromMetres } : {}),
        ...(autoRoute ? { autoRoute: true } : {}),
        ...(autoExplore ? { autoExplore: true } : {}),
      },
    };
    debug?.event({ type: 'routine_end', ...last.routine });
    return { routine: last.routine };
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
    scale: hudScale(screen, layout.reference),
    detection,
    buttons: buttons.map(({ button, bounds }) => ({ id: button.id, label: button.label, bounds })),
  };
}
