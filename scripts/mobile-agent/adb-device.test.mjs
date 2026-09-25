import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdbDevice, adbRawState, labelFromPackage, parseUiautomatorXml } from './adb-device.mjs';
import { createDevice } from './create-device.mjs';
import { MobilerunDevice } from './device.mjs';

const xml = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0"><node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.android.settings" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][1080,2400]"><node index="0" text="Search &amp; find" resource-id="com.android.settings:id/search" class="android.widget.EditText" package="com.android.settings" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="true" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[40,200][1040,320]" /><node index="1" text="Display" resource-id="" class="android.widget.TextView" package="com.android.settings" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,400][1080,520]" /></node></hierarchy>`;
const dump = `<<JEV-XML>>\n${xml}\n<<JEV-IME>>\n  mInputShown=true\n<<JEV-WM>>\nPhysical size: 1080x2400\n`;

function fakeAdb(responses = {}) {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    if (args[0] === 'devices')
      return Buffer.from(
        'List of devices attached\nSERIAL1\tdevice product:x model:Pixel_7 device:y\n',
      );
    if (args[2] === 'get-state') return Buffer.from('device\n');
    const script = args[3];
    for (const [pattern, reply] of Object.entries(responses))
      if (script.includes(pattern)) return Buffer.from(reply);
    if (script.includes('uiautomator dump')) return Buffer.from(dump);
    if (script.includes('getprop')) return Buffer.from('Pixel 7\n');
    if (script.includes('default_input_method'))
      return Buffer.from('com.google.android.inputmethod.latin/.LatinIME\n');
    return Buffer.alloc(0);
  };
  return { calls, run };
}

test('uiautomator XML maps to the shared observation model', () => {
  const { root } = parseUiautomatorXml(xml);
  assert.equal(root.children[0].children[0].text, 'Search & find');
  const raw = adbRawState(dump);
  assert.deepEqual(raw.device_context.screen_bounds, { width: 1080, height: 2400 });
  assert.equal(raw.phone_state.packageName, 'com.android.settings');
  assert.equal(raw.phone_state.keyboardVisible, true);
  assert.equal(raw.phone_state.isEditable, true);
  assert.equal(adbRawState('<<JEV-XML>>\nERROR: could not get idle state'), null);
  assert.equal(
    adbRawState(dump.replace('rotation="0"', 'rotation="1"')).device_context.screen_bounds.width,
    2400,
  );
});

test('ADB device observes and resolves the only connected serial', async () => {
  const { run } = fakeAdb();
  const device = new AdbDevice({ run, deviceId: undefined });
  const observation = await device.observe();
  assert.equal(device.deviceId, 'SERIAL1');
  assert.equal(observation.phone.inputElementId, 'ui.0.0');
  assert.equal(observation.elements.find((e) => e.text === 'Display').clickable, true);
  assert.deepEqual(await device.assertReady(), { id: 'SERIAL1', name: 'Pixel 7', state: 'ready' });
});

test('ADB actions reuse freshness checks and map to input commands', async () => {
  const { calls, run } = fakeAdb();
  const device = new AdbDevice({ run, deviceId: 'SERIAL1' });
  const expected = await device.observe();
  const last = () => calls.at(-1)[3];
  await device.act({ type: 'tap-element', elementId: 'ui.0.1' }, { expected });
  assert.equal(last(), 'input tap 540 460');
  await device.act({ type: 'global', name: 'back' }, { expected });
  assert.equal(last(), 'input keyevent 4');
  await device.act({ type: 'key', key: 'enter' });
  assert.equal(last(), 'input keyevent 66');
  const receipt = await device.act({ type: 'type', text: "it's ok", clear: true }, { expected });
  assert.ok(receipt.inputVerification);
  assert.equal(
    last(),
    `input keyevent 123 && input keyevent ${Array(13).fill(67).join(' ')} && input text 'it'\\''s' && input keyevent 62 && input text 'ok'`,
  );
  await assert.rejects(device.act({ type: 'type', text: '你好' }, { expected }), /ADBKeyboard/);
  assert.ok(!last().includes('input text'));
});

test('ADB typing uses ADBKeyboard for Unicode text and launches apps by package', async () => {
  const { calls, run } = fakeAdb({
    default_input_method: 'com.android.adbkeyboard/.AdbIME\n',
    'query-activities': 'com.android.settings/.Settings\ncom.tencent.mm/.ui.LauncherUI\n',
  });
  const device = new AdbDevice({
    run,
    deviceId: 'SERIAL1',
    appLabels: '{"com.tencent.mm":"微信"}',
  });
  const expected = await device.observe();
  await device.act({ type: 'type', text: '你好', clear: true }, { expected });
  assert.equal(
    calls.at(-1)[3],
    `am broadcast -a ADB_CLEAR_TEXT >/dev/null && am broadcast -a ADB_INPUT_B64 --es msg ${Buffer.from('你好').toString('base64')} >/dev/null`,
  );
  assert.deepEqual(await device.listApps(), [
    { packageName: 'com.android.settings', label: 'settings' },
    { packageName: 'com.tencent.mm', label: '微信' },
  ]);
  await device.act({ type: 'open-app', packageName: 'com.tencent.mm' });
  assert.match(calls.at(-1)[3], /^monkey -p com\.tencent\.mm /);
  assert.equal(labelFromPackage('com.google.android.youtube'), 'youtube');
});

test('ADB raw touch events hold a pointer for game routines', async () => {
  const { calls, run } = fakeAdb();
  const device = new AdbDevice({ deviceId: 'SERIAL1', run });
  await device.touch('down', 5, 6);
  await device.touch('up', 5, 6);
  assert.deepEqual(
    calls.map((args) => args[3]),
    ['input motionevent DOWN 5 6', 'input motionevent UP 5 6'],
  );
  await assert.rejects(device.touch('press', 1, 1), /down, move or up/);
  await assert.rejects(device.touch('down', -1, 1), /nonnegative/);
});

test('backend factory defaults to Mobilerun and selects ADB explicitly', () => {
  assert.ok(createDevice({ deviceId: 'x' }) instanceof MobilerunDevice);
  assert.ok(!(createDevice({ deviceId: 'x' }) instanceof AdbDevice));
  assert.ok(createDevice({ backend: 'adb' }) instanceof AdbDevice);
  assert.throws(() => createDevice({ backend: 'usb' }), /mobilerun or adb/);
});
