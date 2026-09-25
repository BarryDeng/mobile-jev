import { readFileSync } from 'node:fs';
import { toRgba } from './png.mjs';

// Text-line recognition only: layout profiles declare where text appears, so no detector runs.
// Uses the PaddleOCR PP-OCRv4 Chinese recognizer from @gutenye/ocr-models on onnxruntime-node,
// both optional. Everything runs locally; screenshots never leave the machine.
const HEIGHT = 48;
const MAX_WIDTH = 2048;

// Crop a screen-space box, resize to 48 px high and normalize to CHW floats in [-1, 1].
export function preprocess(image, box) {
  const rgba = toRgba(image);
  const { left, top, right, bottom } = box;
  const width = Math.min(
    MAX_WIDTH,
    Math.max(16, Math.round(((right - left) * HEIGHT) / (bottom - top) / 8) * 8),
  );
  const data = new Float32Array(3 * HEIGHT * width);
  const at = (x, y, c) =>
    rgba.pixels[
      (Math.min(Math.max(y, 0), rgba.height - 1) * rgba.width +
        Math.min(Math.max(x, 0), rgba.width - 1)) *
        4 +
        c
    ];
  for (let y = 0; y < HEIGHT; y++)
    for (let x = 0; x < width; x++) {
      const sx = left + ((x + 0.5) * (right - left)) / width - 0.5;
      const sy = top + ((y + 0.5) * (bottom - top)) / HEIGHT - 0.5;
      const x0 = Math.floor(sx),
        y0 = Math.floor(sy),
        fx = sx - x0,
        fy = sy - y0;
      for (let c = 0; c < 3; c++) {
        const v =
          (at(x0, y0, c) * (1 - fx) + at(x0 + 1, y0, c) * fx) * (1 - fy) +
          (at(x0, y0 + 1, c) * (1 - fx) + at(x0 + 1, y0 + 1, c) * fx) * fy;
        data[c * HEIGHT * width + y * width + x] = (v / 255 - 0.5) / 0.5;
      }
    }
  return { data, dims: [1, 3, HEIGHT, width] };
}

// Greedy CTC decoding; class 0 is the blank. Each kept character carries its own score.
export function ctcDecode(scores, [, steps, classes], keys) {
  const chars = [];
  let previous = 0;
  for (let t = 0; t < steps; t++) {
    let best = 0,
      value = -Infinity;
    for (let c = 0; c < classes; c++) {
      const v = scores[t * classes + c];
      if (v > value) [best, value] = [c, v];
    }
    if (best && best !== previous && keys[best] !== undefined)
      chars.push({ char: keys[best], confidence: value });
    previous = best;
  }
  return chars;
}

// Drop individually doubtful characters (stray quotes at crop edges), then trim.
export function joinCharacters(chars, minConfidence) {
  const kept = chars.filter((c) => c.confidence >= minConfidence);
  const text = kept
    .map((c) => c.char)
    .join('')
    .trim();
  return {
    text,
    confidence: text ? kept.reduce((sum, c) => sum + c.confidence, 0) / kept.length : 0,
  };
}

export function loadKeys(path) {
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  return ['', ...lines, ' '];
}

// Returns null when OCR is disabled (JEV_OCR=off) or the optional packages are not installed.
export async function createRecognizer({ minConfidence = 0.5 } = {}) {
  if (['off', '0', 'false'].includes(String(process.env.JEV_OCR ?? '').toLowerCase())) return null;
  let ort, models;
  try {
    ort = (await import('onnxruntime-node')).default;
    models = (await import('@gutenye/ocr-models/node')).default;
  } catch {
    return null;
  }
  const keys = loadKeys(models.dictionaryPath);
  const session = await ort.InferenceSession.create(models.recognitionPath);
  let queue = Promise.resolve();
  const run = async (image, box) => {
    const { data, dims } = preprocess(image, box);
    const outputs = await session.run({
      [session.inputNames[0]]: new ort.Tensor('float32', data, dims),
    });
    const scores = outputs[session.outputNames[0]];
    return joinCharacters(ctcDecode(scores.data, scores.dims, keys), minConfidence);
  };
  return {
    engine: 'PP-OCRv4 rec (onnxruntime-node)',
    // One session: serialize runs instead of sharing it across concurrent calls.
    recognize: (image, box) => {
      const next = queue.then(() => run(image, box));
      queue = next.catch(() => {});
      return next;
    },
  };
}

// Defer loading the model until a layout screen with text regions is first observed.
export function lazyRecognizer(factory = createRecognizer) {
  let pending;
  return {
    recognize: async (image, box) => {
      const recognizer = await (pending ??= factory());
      return recognizer ? recognizer.recognize(image, box) : null;
    },
  };
}
