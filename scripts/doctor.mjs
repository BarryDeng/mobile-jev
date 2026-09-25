import { execFileSync } from 'node:child_process';
import { loadEnvironment } from './env.mjs';
import { createDevice, deviceBackend } from './mobile-agent/create-device.mjs';

loadEnvironment();
const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok, detail });
}
const backend = deviceBackend();
check('Node.js', Number(process.versions.node.split('.')[0]) >= 22, process.versions.node);
if (backend === 'adb') {
  try {
    const output = execFileSync(process.env.ADB_PATH || 'adb', ['version'], { encoding: 'utf8' });
    check('adb', true, output.split('\n')[0].trim());
  } catch {
    check('adb', false, 'Install Android platform-tools or set ADB_PATH.');
  }
} else {
  try {
    const output = execFileSync('curl', ['--version'], { encoding: 'utf8' });
    const version = output.match(/^curl (\d+)\.(\d+)/);
    check(
      'curl',
      Boolean(version && (+version[1] > 7 || (+version[1] === 7 && +version[2] >= 70))),
      output.split('\n')[0].split(' (')[0],
    );
  } catch {
    check('curl', false, 'Install curl 7.70 or newer.');
  }
  check(
    'Mobilerun API key',
    Boolean(process.env.MOBILERUN_API_KEY || process.env.MOBILERUN_CLOUD_API_KEY),
    'Set MOBILERUN_API_KEY in .env.local.',
  );
}
check(
  'TypeSafe API key',
  Boolean(process.env.TYPESAFE_API_KEY),
  'Presence checked; no paid inference is made by doctor.',
);
if (backend === 'mobilerun')
  check(
    'Device ID',
    Boolean(process.env.MOBILERUN_DEVICE_ID),
    'Run pnpm devices, then set MOBILERUN_DEVICE_ID.',
  );
if (
  backend === 'adb'
    ? checks.find((c) => c.name === 'adb')?.ok
    : checks.find((c) => c.name === 'Mobilerun API key')?.ok && process.env.MOBILERUN_DEVICE_ID
) {
  try {
    const device = createDevice();
    const info = await device.assertReady();
    check('Device connection', true, `${info.name || info.id}: ${info.state}`);
    if (backend === 'mobilerun') {
      const capabilities = await device.api(device.path('/capabilities'));
      check(
        'Accessibility',
        capabilities.capabilities?.accessibility === true,
        'A readable accessibility tree is required.',
      );
    }
    const observation = await device.observe();
    check(
      'UI observation',
      true,
      `${observation.elements.length} elements, ${observation.screen.width}×${observation.screen.height}`,
    );
  } catch (error) {
    check('Device connection', false, error.message);
  }
}
for (const item of checks)
  console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}: ${item.detail}`);
if (checks.some((c) => !c.ok)) process.exitCode = 1;
