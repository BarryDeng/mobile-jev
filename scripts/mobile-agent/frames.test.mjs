import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { frameRecorder, localStamp, stampedThumbnail } from './frames.mjs';
import { decodePng, rgbAt } from './png.mjs';

const image = (width, height, rgb) => ({
  width,
  height,
  channels: 3,
  pixels: Buffer.from(Array.from({ length: width * height }, () => rgb).flat()),
});

test('stamped thumbnails halve the frame and add a stamp strip below it', () => {
  const png = decodePng(stampedThumbnail(image(400, 200, [10, 200, 30]), { text: '12:34' }));
  assert.equal(png.width, 200);
  assert.ok(png.height > 100);
  assert.deepEqual(rgbAt(png, 50, 50), [10, 200, 30]);
  const strip = [];
  for (let y = 100; y < png.height; y++)
    for (let x = 0; x < 60; x++) strip.push(rgbAt(png, x, y)[0]);
  assert.ok(strip.includes(255) && strip.includes(0));
});

test('frame recorder names files by capture time and indexes them', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jev-frames-'));
  try {
    const save = frameRecorder(dir);
    const capturedAt = new Date(2026, 9, 15, 6, 30, 12, 345).getTime();
    const observation = { layout: { screen: 'world' } };
    Object.defineProperty(observation, 'frame', {
      value: { image: image(40, 20, [0, 0, 0]), capturedAt },
    });
    assert.equal(await save({ step: 3, observation: { layout: {} } }), undefined);
    const entry = await save({ step: 3, observation });
    assert.equal(entry.file, '000-step03-063012345.png');
    assert.equal(entry.localTime, localStamp(new Date(capturedAt)));
    assert.equal(entry.screen, 'world');
    assert.equal(JSON.stringify(observation), '{"layout":{"screen":"world"}}');
    assert.deepEqual((await readdir(dir)).sort(), ['000-step03-063012345.png', 'frames.jsonl']);
    const index = JSON.parse(await readFile(join(dir, 'frames.jsonl'), 'utf8'));
    assert.equal(index.capturedAt, new Date(capturedAt).toISOString());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
