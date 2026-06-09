// ============================================================================
//  png.mjs — a minimal truecolour PNG encoder (node:zlib only, no native deps),
//  shared by the offline renderers (heatmap.mjs region map, plan-map.mjs room
//  layout). A PNG is an 8-byte signature followed by chunks; we emit the three
//  mandatory ones: IHDR (header), IDAT (deflated pixels), IEND (terminator).
//  Each chunk is CRC-protected, so we carry the PNG/zlib CRC-32.
// ============================================================================
import { deflateSync } from "node:zlib";

// CRC-32 lookup table, reflected polynomial 0xEDB88320 (the PNG/zlib variant).
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// One PNG chunk: 4-byte big-endian length, 4-byte type, data, CRC32(type+data).
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const tb = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([tb, data])), 0);
  return Buffer.concat([len, tb, data, crc]);
}

// Encode a truecolour (RGB) image. `rgb` is a width*height*3 byte buffer.
export function encodePng(width, height, rgb) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour RGB
  // raw scanlines, each prefixed with filter byte 0
  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}
