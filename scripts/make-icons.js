#!/usr/bin/env node
// Rasterizes the app icon to PNG without any image dependency: render the shapes
// into an RGBA buffer with 3x3 supersampling, then deflate it into a PNG.
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BG = [0x2a, 0x78, 0xd6];
const FG = [0xfc, 0xfc, 0xfb];

/** Signed distance from p to the segment ab. */
function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Coverage of the icon artwork at unit coordinates (0..1), supersampled. */
function sample(u, v) {
  const x = u * 512, y = v * 512;

  // Rounded-rect background, r = 114.
  const rx = Math.max(Math.abs(x - 256) - (256 - 114), 0);
  const ry = Math.max(Math.abs(y - 256) - (256 - 114), 0);
  if (Math.hypot(rx, ry) > 114) return null;

  const r = Math.hypot(x - 256, y - 256);
  // Dial ring: radius 150, stroke 30.
  if (Math.abs(r - 150) <= 15) return FG;
  // Hands: vertical 154->262, then out to (330, 312); round caps => 15px radius.
  if (distToSegment(x, y, 256, 154, 256, 262) <= 15) return FG;
  if (distToSegment(x, y, 256, 262, 330, 312) <= 15) return FG;
  return BG;
}

function render(size) {
  const SS = 3;
  const buf = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = sample((px + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size);
          if (c) { r += c[0]; g += c[1]; b += c[2]; a += 255; }
        }
      }
      const n = SS * SS;
      const i = (py * size + px) * 4;
      // Un-premultiply so edge pixels keep their colour as alpha falls off.
      const cov = a / (255 * n);
      buf[i] = cov ? r / (n * cov) : 0;
      buf[i + 1] = cov ? g / (n * cov) : 0;
      buf[i + 2] = cov ? b / (n * cov) : 0;
      buf[i + 3] = a / n;
    }
  }
  return buf;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

let TABLE;
function crc32(buf) {
  if (!TABLE) {
    TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      TABLE[n] = c;
    }
  }
  let c = -1;
  for (const byte of buf) c = TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

function png(size) {
  const rgba = render(size);
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const outDir = fileURLToPath(new URL('../public/', import.meta.url));
for (const size of [192, 512]) {
  writeFileSync(`${outDir}icon-${size}.png`, png(size));
  console.log(`wrote public/icon-${size}.png`);
}
