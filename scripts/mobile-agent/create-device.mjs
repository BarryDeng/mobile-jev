import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MobilerunDevice } from './device.mjs';
import { AdbDevice } from './adb-device.mjs';
import { loadLayout, withLayout } from './layout.mjs';
import { lazyRecognizer } from './ocr.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export function deviceBackend(backend = process.env.JEV_DEVICE_BACKEND) {
  const name = (backend || 'mobilerun').toLowerCase();
  if (!['mobilerun', 'adb'].includes(name))
    throw new Error('JEV_DEVICE_BACKEND must be mobilerun or adb.');
  return name;
}

// Select the device transport; both backends share the same validation and action contract.
// An optional layout profile (JEV_LAYOUT) adds fixed controls for apps without a UI tree, and
// reads its declared text regions with local OCR when the optional OCR packages are installed.
export function createDevice({
  backend,
  layout = process.env.JEV_LAYOUT,
  recognizer = lazyRecognizer(),
  ...options
} = {}) {
  for (const key of Object.keys(options)) if (options[key] === undefined) delete options[key];
  const device =
    deviceBackend(backend) === 'adb' ? new AdbDevice(options) : new MobilerunDevice(options);
  if (!layout) return device;
  return withLayout(
    device,
    typeof layout === 'string'
      ? loadLayout(isAbsolute(layout) ? layout : resolve(root, layout))
      : layout,
    { recognizer },
  );
}
