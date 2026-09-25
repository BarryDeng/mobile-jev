import { crc32, deflateSync, inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

// Minimal decoder for the 8-bit, non-interlaced PNGs produced by Android screencap.
export function decodePng(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.subarray(0, 8).equals(SIGNATURE))
    throw new Error('Screenshot is not a PNG.');
  let offset = 8,
    header;
  const data = [];
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    const chunk = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR')
      header = {
        width: chunk.readUInt32BE(0),
        height: chunk.readUInt32BE(4),
        depth: chunk[8],
        color: chunk[9],
        interlace: chunk[12],
      };
    else if (type === 'IDAT') data.push(chunk);
    else if (type === 'IEND') break;
    offset += length + 12;
  }
  const channels = CHANNELS[header?.color];
  if (!header || header.depth !== 8 || !channels || header.interlace !== 0)
    throw new Error('Only 8-bit non-interlaced grayscale/RGB(A) PNGs are supported.');
  const { width, height } = header;
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  if (raw.length < height * (stride + 1)) throw new Error('PNG image data is truncated.');
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? pixels[out + x - channels] : 0;
      const b = y ? pixels[out - stride + x] : 0;
      const c = x >= channels && y ? pixels[out - stride + x - channels] : 0;
      let predictor = 0;
      if (filter === 1) predictor = a;
      else if (filter === 2) predictor = b;
      else if (filter === 3) predictor = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a),
          pb = Math.abs(p - b),
          pc = Math.abs(p - c);
        predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) throw new Error('Invalid PNG filter.');
      pixels[out + x] = (line[x] + predictor) & 255;
    }
  }
  return { width, height, channels, pixels };
}

export function rgbAt(image, x, y) {
  const i = (y * image.width + x) * image.channels;
  if (image.channels >= 3) return [image.pixels[i], image.pixels[i + 1], image.pixels[i + 2]];
  return [image.pixels[i], image.pixels[i], image.pixels[i]];
}

export function toRgba(image) {
  const out = Buffer.alloc(image.width * image.height * 4);
  for (let y = 0; y < image.height; y++)
    for (let x = 0; x < image.width; x++) {
      const [r, g, b] = rgbAt(image, x, y);
      const i = (y * image.width + x) * 4;
      const alpha =
        image.channels === 4
          ? image.pixels[(y * image.width + x) * 4 + 3]
          : image.channels === 2
            ? image.pixels[(y * image.width + x) * 2 + 1]
            : 255;
      out[i] = r;
      out[i + 1] = g;
      out[i + 2] = b;
      out[i + 3] = alpha;
    }
  return { width: image.width, height: image.height, channels: 4, pixels: out };
}

export function encodePng({ width, height, channels = 4, pixels }) {
  if (channels !== 4) throw new Error('encodePng expects RGBA pixels.');
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++)
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
