import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { MobilerunDevice, summarizeState } from './device.mjs';
import { decodePng } from './png.mjs';

// Android keycodes for the Mobilerun global-action numbers used by MobilerunDevice.act.
const GLOBAL_KEYCODES = { 1: 4, 2: 3, 3: 187 };
const KEYCODE_SPACE = 62;
const KEYCODE_MOVE_END = 123;
const KEYCODE_DEL = 67;
const PACKAGE_NAME = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)+$/;
const MARK = { xml: '<<JEV-XML>>', ime: '<<JEV-IME>>', wm: '<<JEV-WM>>' };

const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (value) =>
  value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, name) =>
    name[0] === '#'
      ? String.fromCodePoint(
          name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1)),
        )
      : entities[name.toLowerCase()] || match,
  );

// Parse `uiautomator dump` XML into the accessibility-tree shape summarizeState expects.
export function parseUiautomatorXml(xml) {
  const root = { children: [] };
  const stack = [root];
  let rotation = 0;
  for (const [, closing, tag, rawAttributes, selfClosing] of xml.matchAll(
    /<(\/?)(node|hierarchy)\b([^>]*?)(\/?)>/g,
  )) {
    if (closing) {
      if (tag === 'node' && stack.length > 1) stack.pop();
      continue;
    }
    const a = {};
    for (const [, key, value] of rawAttributes.matchAll(/([\w-]+)="([^"]*)"/g))
      a[key] = decode(value);
    if (tag === 'hierarchy') {
      rotation = Number(a.rotation) || 0;
      continue;
    }
    const bounds = a.bounds?.match(/^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/);
    const node = {
      className: a.class || '',
      packageName: a.package || '',
      text: a.text || '',
      contentDescription: a['content-desc'] || '',
      resourceId: a['resource-id'] || '',
      hint: a.hint || '',
      boundsInScreen: bounds
        ? { left: +bounds[1], top: +bounds[2], right: +bounds[3], bottom: +bounds[4] }
        : undefined,
      isClickable: a.clickable === 'true',
      isScrollable: a.scrollable === 'true',
      isEnabled: a.enabled !== 'false',
      isFocused: a.focused === 'true',
      isPassword: a.password === 'true',
      isCheckable: a.checkable === 'true',
      isChecked: a.checked === 'true',
      isSelected: a.selected === 'true',
      isVisibleToUser: a['visible-to-user'] !== 'false',
      children: [],
    };
    stack.at(-1).children.push(node);
    if (!selfClosing) stack.push(node);
  }
  return { rotation, root };
}

const EDIT_CLASSES = [
  'android.widget.EditText',
  'android.widget.AutoCompleteTextView',
  'android.widget.MultiAutoCompleteTextView',
];

// Build a Mobilerun-compatible raw UI state from one combined adb shell read.
export function adbRawState(output) {
  const section = (name) => {
    const start = output.indexOf(MARK[name]);
    if (start < 0) return '';
    const rest = output.slice(start + MARK[name].length);
    const next = Object.values(MARK)
      .map((mark) => rest.indexOf(mark))
      .filter((i) => i >= 0);
    return next.length ? rest.slice(0, Math.min(...next)) : rest;
  };
  const xml = section('xml');
  if (!xml.includes('<hierarchy')) return null;
  const { rotation, root } = parseUiautomatorXml(xml);
  const wm = section('wm');
  const size = (
    wm.match(/Override size:\s*(\d+)x(\d+)/) || wm.match(/Physical size:\s*(\d+)x(\d+)/)
  )
    ?.slice(1)
    .map(Number);
  let width, height;
  if (size) [width, height] = rotation % 2 ? [size[1], size[0]] : size;
  else {
    width = Math.max(0, ...root.children.map((n) => n.boundsInScreen?.right ?? 0));
    height = Math.max(0, ...root.children.map((n) => n.boundsInScreen?.bottom ?? 0));
  }
  let focused;
  const visit = (node) => {
    if (node.isFocused && !focused) focused = node;
    node.children.forEach(visit);
  };
  visit(root);
  const packageName = root.children.find((n) => n.packageName)?.packageName || '';
  return {
    device_context: { screen_bounds: { width, height } },
    phone_state: {
      packageName,
      currentApp: packageName,
      isEditable: Boolean(focused && EDIT_CLASSES.includes(focused.className)),
      keyboardVisible: /(mInputShown|mIsInputViewShown|isInputViewShown)=true/.test(section('ime')),
      focusedElement: {
        resourceId: focused?.resourceId || '',
        className: focused?.className || '',
      },
    },
    a11y_tree: root,
  };
}

// Readable default labels from package names; override with ADB_APP_LABELS JSON.
export function labelFromPackage(packageName) {
  const generic = new Set(['com', 'org', 'net', 'cn', 'io', 'android', 'google', 'apps', 'app']);
  const parts = packageName.split('.');
  return parts.filter((p) => !generic.has(p.toLowerCase())).at(-1) || parts.at(-1);
}

const quote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

// `screencap` without -p: width, height, format (u32 LE), plus a u32 colour space since Android 9,
// then RGBA_8888 rows. Other pixel formats are rejected rather than misread.
export function decodeRawScreencap(bytes) {
  if (bytes.length < 12) throw new Error('Raw screenshot is truncated.');
  const width = bytes.readUInt32LE(0),
    height = bytes.readUInt32LE(4),
    format = bytes.readUInt32LE(8);
  const size = width * height * 4;
  const header = bytes.length - size;
  if (!width || !height || (header !== 12 && header !== 16))
    throw new Error('Raw screenshot has an unexpected size.');
  if (format !== 1 && format !== 2)
    throw new Error(
      `Raw screenshot pixel format ${format} is not RGBA/RGBX 8888; use ADB_CAPTURE=png.`,
    );
  return { width, height, channels: 4, pixels: bytes.subarray(header) };
}

function runAdb(adbPath, args, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      adbPath,
      args,
      { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024, timeout: timeoutMs, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          const detail = (stderr?.toString() || '').trim().split('\n')[0];
          reject(
            new Error(
              error.code === 'ENOENT'
                ? 'Could not run adb. Install Android platform-tools or set ADB_PATH.'
                : `adb failed${detail ? `: ${detail}` : ''}. Actions are not retried; observe before trying again.`,
            ),
          );
        } else resolve(stdout);
      },
    );
  });
}

export class AdbDevice extends MobilerunDevice {
  constructor({
    deviceId = process.env.ADB_SERIAL || undefined,
    adbPath = process.env.ADB_PATH || 'adb',
    appLabels = process.env.ADB_APP_LABELS,
    capture = process.env.ADB_CAPTURE || 'png',
    textCompletionMode,
    run = (args, options) => runAdb(adbPath, args, options),
  } = {}) {
    super({ deviceId, textCompletionMode, baseUrl: 'https://adb.invalid' });
    this.deviceId = deviceId; // Do not inherit MOBILERUN_DEVICE_ID.
    this.baseUrl = 'adb';
    this.run = run;
    if (!['png', 'raw'].includes(capture)) throw new Error('ADB_CAPTURE must be png or raw.');
    this.capture = capture;
    try {
      this.appLabels = typeof appLabels === 'string' ? JSON.parse(appLabels) : appLabels || {};
    } catch {
      throw new Error('ADB_APP_LABELS must be a JSON object of packageName to label.');
    }
    this.deviceName = undefined;
  }

  async api() {
    throw new Error('The Mobilerun API is not available with the ADB backend.');
  }

  async serial() {
    if (this.deviceId) return this.deviceId;
    const ready = (await this.listDevices()).filter((d) => d.state === 'ready');
    if (ready.length !== 1)
      throw new Error(
        `Found ${ready.length} ready adb devices; set ADB_SERIAL or pass --device. Use devices to list IDs.`,
      );
    this.deviceId = ready[0].id;
    return this.deviceId;
  }

  async shell(script, options) {
    const bytes = await this.run(['-s', await this.serial(), 'exec-out', script], options);
    return bytes;
  }

  async listDevices() {
    const output = (await this.run(['devices', '-l'])).toString('utf8');
    return output
      .split(/\r?\n/)
      .slice(1)
      .map((line) => line.trim().split(/\s+/))
      .filter((parts) => parts.length >= 2 && parts[0])
      .map(([id, state, ...rest]) => ({
        id,
        name:
          rest
            .find((p) => p.startsWith('model:'))
            ?.slice(6)
            .replace(/_/g, ' ') || id,
        state: state === 'device' ? 'ready' : state,
      }));
  }

  async listApps() {
    const output = (
      await this.shell(
        'cmd package query-activities -a android.intent.action.MAIN -c android.intent.category.LAUNCHER 2>/dev/null || pm list packages',
      )
    ).toString('utf8');
    const packages = new Set();
    for (const [, name] of output.matchAll(/(?:packageName=|package:)([A-Za-z0-9_.]+)/g))
      packages.add(name);
    for (const [, name] of output.matchAll(/^\s*([A-Za-z0-9_.]+)\/[A-Za-z0-9_.$]+\s*$/gm))
      packages.add(name);
    this.installedApps = [...packages]
      .filter((name) => PACKAGE_NAME.test(name))
      .sort()
      .map((packageName) => ({
        packageName,
        label: String(this.appLabels[packageName] || labelFromPackage(packageName)),
      }));
    return this.installedApps;
  }

  async assertReady() {
    const id = await this.serial();
    const state = (await this.run(['-s', id, 'get-state'])).toString('utf8').trim();
    if (state !== 'device')
      throw new Error(`Device is ${state || 'unknown'}; it must be ready (adb state "device").`);
    this.deviceName ??=
      (await this.shell('getprop ro.product.model')).toString('utf8').trim() || id;
    this.readyAt = performance.now();
    return { id, name: this.deviceName, state: 'ready' };
  }

  async describe() {
    const info = await this.assertReady();
    return { ...info, streamUrl: null, streamToken: null, environment: 'ADB' };
  }

  async observe() {
    await this.serial();
    const file = '/data/local/tmp/jev-ui.xml';
    const script = [
      `rm -f ${file}`,
      `uiautomator dump ${file} >/dev/null 2>&1`,
      `echo '${MARK.xml}'`,
      `cat ${file} 2>/dev/null`,
      `echo '${MARK.ime}'`,
      `dumpsys input_method | grep -E 'mInputShown|mIsInputViewShown|isInputViewShown'`,
      `echo '${MARK.wm}'`,
      'wm size',
    ].join('; ');
    // A dump can fail while the screen animates; reading is side-effect free, so retry it.
    for (let attempt = 0; attempt < 3; attempt++) {
      const raw = adbRawState((await this.shell(script)).toString('utf8'));
      if (raw && raw.a11y_tree.children.length) return summarizeState(raw, this.deviceId);
      await delay(150);
    }
    throw new Error('uiautomator dump failed; the screen may be animating or locked.');
  }

  // Used by layout profiles: reads the focused app without a uiautomator dump.
  async foregroundPackage() {
    const output = (
      await this.shell("dumpsys window | grep -E 'mCurrentFocus|mFocusedApp'")
    ).toString('utf8');
    for (const line of output.split(/\r?\n/)) {
      const match = line.match(/\s([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+)\/[^\s}]+/);
      if (match) return match[1];
    }
    return '';
  }

  async screenshot() {
    const bytes = await this.shell('screencap -p');
    if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
      throw new Error('Screenshot response is not a PNG.');
    return bytes;
  }

  // Decoded pixels for layout profiles. `raw` skips on-device PNG encoding (about 2x faster on a
  // phone), but some emulators (LDPlayer) return stale raw frames, so PNG stays the default.
  async frame() {
    if (this.capture === 'png') return decodePng(await this.screenshot());
    return decodeRawScreencap(await this.shell('screencap'));
  }

  // Raw single-pointer events: a held pointer (down, moves, up) steers a game's virtual joystick.
  async touch(event, x, y) {
    const name = { down: 'DOWN', move: 'MOVE', up: 'UP' }[event];
    if (!name) throw new Error('Touch event must be down, move or up.');
    if (![x, y].every((v) => Number.isSafeInteger(v) && v >= 0))
      throw new Error('Touch coordinates must be nonnegative integers.');
    await this.shell(`input motionevent ${name} ${x} ${y}`);
  }

  async launchApp(packageName) {
    if (!PACKAGE_NAME.test(packageName)) throw new Error('Invalid package name.');
    const output = (
      await this.shell(`monkey -p ${packageName} -c android.intent.category.LAUNCHER 1 2>&1`)
    ).toString('utf8');
    if (/No activities found|monkey aborted/i.test(output))
      throw new Error('The app has no launcher activity.');
  }

  async hasAdbKeyboard() {
    const ime = (await this.shell('settings get secure default_input_method')).toString('utf8');
    return ime.trim().startsWith('com.android.adbkeyboard/');
  }

  async clearScript(current, adbKeyboard) {
    if (adbKeyboard) return ['am broadcast -a ADB_CLEAR_TEXT >/dev/null'];
    const target = current.elements.find((e) => e.id === current.phone.inputElementId);
    const count = target && !target.password ? Math.max(target.text.length, 1) : 64;
    const script = [`input keyevent ${KEYCODE_MOVE_END}`];
    for (let left = count; left > 0; left -= 50)
      script.push(`input keyevent ${Array(Math.min(left, 50)).fill(KEYCODE_DEL).join(' ')}`);
    return script;
  }

  async send(suffix, method, body, current) {
    let script;
    if (suffix === '/tap') script = [`input tap ${body.x} ${body.y}`];
    else if (suffix === '/swipe')
      script = [
        `input swipe ${body.startX} ${body.startY} ${body.endX} ${body.endY} ${body.duration}`,
      ];
    else if (suffix === '/global') script = [`input keyevent ${GLOBAL_KEYCODES[body.action]}`];
    else if (suffix === '/keyboard' && method === 'PUT')
      script = [`input keyevent ${Number(body.key)}`];
    else if (suffix === '/keyboard' && method === 'DELETE')
      script = await this.clearScript(current, await this.hasAdbKeyboard());
    else if (suffix === '/keyboard' && method === 'POST') {
      const ascii = /^[\x20-\x7e]*$/.test(body.text);
      const adbKeyboard = !ascii || body.clear ? await this.hasAdbKeyboard() : false;
      // Reject before any input so unsupported text never leaves a half-edited field.
      if (!ascii && !adbKeyboard)
        throw new Error(
          'Non-ASCII text needs ADBKeyboard (com.android.adbkeyboard) set as the default input method.',
        );
      script = body.clear ? await this.clearScript(current, adbKeyboard) : [];
      if (!body.text) {
        // Clearing only.
      } else if (!ascii) {
        const encoded = Buffer.from(body.text, 'utf8').toString('base64');
        script.push(`am broadcast -a ADB_INPUT_B64 --es msg ${encoded} >/dev/null`);
      } else {
        // `input text` cannot type literal spaces reliably; send them as key events.
        body.text.split(' ').forEach((part, i) => {
          if (i) script.push(`input keyevent ${KEYCODE_SPACE}`);
          if (part) script.push(`input text ${quote(part)}`);
        });
      }
    } else throw new Error('Unsupported action for the ADB backend.');
    if (script.length) await this.shell(script.join(' && '));
  }
}
