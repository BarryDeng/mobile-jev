import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createRecognizer,
  ctcDecode,
  joinCharacters,
  lazyRecognizer,
  loadKeys,
  preprocess,
} from './ocr.mjs';
import { decodePng, encodePng } from './png.mjs';

test('preprocess crops to a 48 px line normalized to [-1, 1]', () => {
  const pixels = Buffer.alloc(40 * 10 * 4);
  for (let i = 0; i < 40 * 10; i++)
    pixels.set(i % 40 < 20 ? [0, 0, 0, 255] : [255, 255, 255, 255], i * 4);
  const { data, dims } = preprocess(decodePng(encodePng({ width: 40, height: 10, pixels })), {
    left: 0,
    top: 0,
    right: 40,
    bottom: 10,
  });
  assert.deepEqual(dims, [1, 3, 48, 192]);
  assert.equal(data.length, 3 * 48 * 192);
  assert.equal(data[0], -1);
  assert.equal(data[191], 1);
  // Green channel plane of the bottom-right pixel.
  assert.equal(data[48 * 192 + 47 * 192 + 191], 1);
});

test('CTC decoding collapses repeats, skips blanks and drops doubtful characters', () => {
  const keys = ['', '"', '好', '的', ' '];
  const steps = [
    [0, 0.6, 0, 0, 0],
    [0.9, 0, 0.05, 0, 0],
    [0, 0, 0.95, 0, 0],
    [0, 0, 0.9, 0, 0],
    [0.9, 0, 0, 0, 0],
    [0, 0, 0.8, 0, 0],
    [0, 0, 0, 0.7, 0],
  ];
  const chars = ctcDecode(steps.flat(), [1, steps.length, keys.length], keys);
  assert.deepEqual(
    chars.map((c) => c.char),
    ['"', '好', '好', '的'],
  );
  assert.deepEqual(joinCharacters(chars, 0.5), {
    text: '"好好的',
    confidence: (0.6 + 0.95 + 0.8 + 0.7) / 4,
  });
  assert.equal(joinCharacters(chars, 0.65).text, '好好的');
  assert.deepEqual(joinCharacters([], 0.5), { text: '', confidence: 0 });
});

test('dictionary keys reserve the blank and append a space', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-ocr-'));
  try {
    writeFileSync(join(dir, 'keys.txt'), '好\r\n的\r\n');
    assert.deepEqual(loadKeys(join(dir, 'keys.txt')), ['', '好', '的', ' ']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('OCR can be switched off and loads its engine only once, on first use', async () => {
  const previous = process.env.JEV_OCR;
  process.env.JEV_OCR = 'off';
  try {
    assert.equal(await createRecognizer(), null);
  } finally {
    if (previous === undefined) delete process.env.JEV_OCR;
    else process.env.JEV_OCR = previous;
  }
  let loads = 0;
  const lazy = lazyRecognizer(async () => {
    loads++;
    return { recognize: async () => ({ text: 'x', confidence: 1 }) };
  });
  assert.equal(loads, 0);
  await Promise.all([lazy.recognize(), lazy.recognize()]);
  assert.equal(loads, 1);
  assert.equal(await lazyRecognizer(async () => null).recognize(), null);
});
