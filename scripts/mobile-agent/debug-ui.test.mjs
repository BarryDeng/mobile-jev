import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodePng, rgbAt } from './png.mjs';
import { frameOverlay, startDebugUi, summarizeEvent, thumbnailPng } from './debug-ui.mjs';

const image = (width, height, paint) => {
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const [r, g, b] = paint(x, y);
      pixels.set([r, g, b, 255], (y * width + x) * 4);
    }
  return { width, height, channels: 4, pixels };
};

test('thumbnails downscale the frame into a valid RGB PNG', () => {
  const frame = image(12, 6, (x) => (x < 6 ? [200, 10, 10] : [10, 10, 200]));
  const png = decodePng(thumbnailPng(frame, 3));
  assert.deepEqual([png.width, png.height], [4, 2]);
  assert.deepEqual(rgbAt(png, 0, 0), [200, 10, 10]);
  assert.deepEqual(rgbAt(png, 3, 1), [10, 10, 200]);
});

test('the overlay shows the health-bar region and its fill', () => {
  const layout = {
    reference: { width: 100, height: 50 },
    healthBar: { x: 35, y: 42, w: 50, h: 4, rgb: [150, 215, 34], tolerance: 40 },
  };
  const frame = image(100, 50, (x, y) =>
    y >= 40 && y < 44 && x >= 10 && x < 35 ? [150, 215, 34] : [60, 50, 50],
  );
  const overlay = frameOverlay(layout, frame);
  assert.deepEqual(overlay.boxes, [{ kind: 'health_bar', x: 10, y: 40, w: 50, h: 4 }]);
  assert.ok(overlay.health > 0.4 && overlay.health < 0.6);
});

test('trace events become short summaries; model traffic is skipped', () => {
  assert.equal(summarizeEvent({ event: 'model_request', body: {} }), undefined);
  assert.deepEqual(
    summarizeEvent({
      event: 'decision',
      step: 3,
      cycle: 1,
      status: 'action',
      operation: 'TAP',
      choice: 'layout-routine.combat',
      supervised: true,
      reason: 'health fell',
    }),
    {
      kind: 'decision',
      step: 3,
      cycle: 1,
      by: 'supervisor',
      status: 'action',
      operation: 'TAP',
      choice: 'layout-routine.combat',
      confidence: undefined,
      reason: 'health fell',
    },
  );
  const state = summarizeEvent({
    event: 'observation',
    step: 2,
    observation: {
      phone: { packageName: 'com.game' },
      layout: { screen: 'world', threat: 'attacked' },
      elements: [
        { id: 'layout-text.active_health', text: '100/200' },
        { id: 'layout-routine.combat' },
        { id: 'layout.jump' },
      ],
    },
  });
  assert.equal(state.screen, 'world');
  assert.equal(state.threat, 'attacked');
  assert.deepEqual(state.texts, { active_health: '100/200' });
  assert.deepEqual(state.routines, ['combat']);
});

test('the debug server streams events and serves the latest frame on request', async () => {
  const ui = await startDebugUi({ open: false });
  try {
    ui.publish({ event: 'decision', step: 0, status: 'action', operation: 'BACK' });
    ui.device.frame({ image: image(30, 12, () => [1, 2, 3]), screen: 'world', source: 'observe' });
    const page = await fetch(ui.url);
    assert.match(await page.text(), /Jev 调试/);
    const controller = new AbortController();
    const events = await fetch(`${ui.url}events`, { signal: controller.signal });
    const reader = events.body.getReader();
    const { value } = await reader.read();
    const history = JSON.parse(new TextDecoder().decode(value).replace(/^data: /, ''));
    assert.deepEqual(
      history.map((m) => m.kind),
      ['decision', 'frame'],
    );
    controller.abort();
    const frame = await fetch(`${ui.url}frame.png`);
    assert.equal(frame.headers.get('x-frame-id'), '1');
    const png = decodePng(Buffer.from(await frame.arrayBuffer()));
    assert.deepEqual([png.width, png.height], [10, 4]);
  } finally {
    await ui.close();
  }
});
