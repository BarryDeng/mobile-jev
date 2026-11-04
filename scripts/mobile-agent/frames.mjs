import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { encodePng, rgbAt } from './png.mjs';

// 3x5 bitmap glyphs: each row is 3 bits, most significant bit on the left.
const GLYPHS = {
  0: [7, 5, 5, 5, 7],
  1: [2, 6, 2, 2, 7],
  2: [7, 1, 7, 4, 7],
  3: [7, 1, 7, 1, 7],
  4: [5, 5, 7, 1, 1],
  5: [7, 4, 7, 1, 7],
  6: [7, 4, 7, 5, 7],
  7: [7, 1, 1, 1, 1],
  8: [7, 5, 7, 5, 7],
  9: [7, 5, 7, 1, 7],
  ':': [0, 2, 0, 2, 0],
  '-': [0, 0, 7, 0, 0],
  '.': [0, 0, 0, 0, 2],
  '[': [6, 4, 4, 4, 6],
  ']': [3, 1, 1, 1, 3],
  ' ': [0, 0, 0, 0, 0],
};

const pad = (n, width = 2) => String(n).padStart(width, '0');

// Local wall-clock time, the same clock the user reads on the phone and the PC.
export function localStamp(date) {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.` +
    pad(date.getMilliseconds(), 3)
  );
}

// Downscale by an integer factor (box average) and add a black strip with `text` underneath,
// so the stamp never covers game UI.
export function stampedThumbnail(image, { factor = 2, text = '' } = {}) {
  const width = Math.floor(image.width / factor),
    height = Math.floor(image.height / factor);
  const scale = Math.max(2, Math.round(height / 180));
  const strip = 7 * scale;
  const pixels = Buffer.alloc(width * (height + strip) * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let r = 0,
        g = 0,
        b = 0;
      for (let dy = 0; dy < factor; dy++)
        for (let dx = 0; dx < factor; dx++) {
          const [pr, pg, pb] = rgbAt(image, x * factor + dx, y * factor + dy);
          r += pr;
          g += pg;
          b += pb;
        }
      const n = factor * factor,
        i = (y * width + x) * 4;
      pixels[i] = Math.round(r / n);
      pixels[i + 1] = Math.round(g / n);
      pixels[i + 2] = Math.round(b / n);
      pixels[i + 3] = 255;
    }
  for (let i = width * height * 4; i < pixels.length; i += 4) pixels[i + 3] = 255;
  let left = scale;
  for (const char of text) {
    const rows = GLYPHS[char] ?? GLYPHS[' '];
    for (let row = 0; row < 5; row++)
      for (let col = 0; col < 3; col++) {
        if (!(rows[row] & (4 >> col))) continue;
        for (let sy = 0; sy < scale; sy++)
          for (let sx = 0; sx < scale; sx++) {
            const x = left + col * scale + sx,
              y = height + scale + row * scale + sy;
            if (x >= width) continue;
            pixels.fill(255, (y * width + x) * 4, (y * width + x) * 4 + 3);
          }
      }
    left += 4 * scale;
  }
  return encodePng({ width, height: height + strip, channels: 4, pixels });
}

// Saves the frame each agent observation was read from, named and stamped with its capture time.
export function frameRecorder(dir, { factor = 2 } = {}) {
  let count = 0,
    ready;
  return async ({ step, initial, observation }) => {
    const frame = observation?.frame;
    if (!frame?.image) return undefined;
    ready ??= mkdir(dir, { recursive: true });
    await ready;
    const at = new Date(frame.capturedAt);
    const stamp = localStamp(at);
    const label = initial ? 'start' : `step${pad(step)}`;
    const file = `${pad(count++, 3)}-${label}-${stamp.slice(11).replace(/[:.]/g, '')}.png`;
    await writeFile(
      join(dir, file),
      stampedThumbnail(frame.image, {
        factor,
        text: `${stamp} ${initial ? '' : `[${step}]`}`,
      }),
      { flag: 'wx', mode: 0o600 },
    );
    const entry = {
      file,
      step: initial ? null : step,
      capturedAt: at.toISOString(),
      localTime: stamp,
      screen: observation.layout?.screen ?? null,
    };
    await appendFile(join(dir, 'frames.jsonl'), JSON.stringify(entry) + '\n', { mode: 0o600 });
    return entry;
  };
}
