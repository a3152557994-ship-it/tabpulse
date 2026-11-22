// Zero-dependency ISO/IEC 18004 QR Code SVG Generator (Versions 1–10, EC Level L, Byte Mode)
// Generates crisp scannable <svg> locally with zero external API calls.

const CAPACITIES_L = [0, 17, 32, 53, 78, 106, 134, 154, 192, 230, 271];
// [totalDataCodewords, ecCodewordsPerBlock, numBlocksGroup1, dataCwGroup1, numBlocksGroup2, dataCwGroup2]
const BLOCK_TABLE_L = [
  null,
  [19, 7, 1, 19, 0, 0],
  [34, 10, 1, 34, 0, 0],
  [55, 15, 1, 55, 0, 0],
  [80, 20, 1, 80, 0, 0],
  [108, 26, 1, 108, 0, 0],
  [136, 18, 2, 68, 0, 0],
  [156, 20, 2, 78, 0, 0],
  [194, 24, 2, 97, 0, 0],
  [232, 30, 2, 116, 0, 0],
  [274, 18, 2, 68, 2, 69],
];

const ALIGNMENT_POS = [
  [],
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMul(a, b) {
  return a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function rsGeneratorPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    const root = GF_EXP[i];
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], root);
    }
    poly = next;
  }
  return poly;
}

function rsRemainder(data, degree) {
  const gen = rsGeneratorPoly(degree);
  const rem = new Uint8Array(degree);
  for (const byte of data) {
    const factor = byte ^ rem[0];
    rem.copyWithin(0, 1);
    rem[degree - 1] = 0;
    if (factor !== 0) {
      for (let j = 0; j < degree; j++) {
        rem[j] ^= gfMul(gen[j + 1], factor);
      }
    }
  }
  return rem;
}

function bchFormatInfo(mask) {
  // EC Level L = 01
  const data = (0b01 << 3) | mask;
  let rem = data << 10;
  for (let i = 14; i >= 10; i--) {
    if ((rem >> i) & 1) rem ^= 0b10100110111 << (i - 10);
  }
  return ((data << 10) | rem) ^ 0b101010000010010;
}

export function encodeQrMatrix(text) {
  const bytes = Buffer.from(String(text), "utf-8");
  let ver = 1;
  while (ver <= 10 && bytes.length > CAPACITIES_L[ver]) ver++;
  if (ver > 10) throw new Error("QR text exceeds Version 10 capacity");

  const [totalDataCw, ecLen, g1Blocks, g1Cw, g2Blocks, g2Cw] = BLOCK_TABLE_L[ver];
  const bits = [];
  const pushBits = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1);
  };

  pushBits(0b0100, 4); // Byte mode
  pushBits(bytes.length, ver <= 9 ? 8 : 16);
  for (const b of bytes) pushBits(b, 8);

  const maxBits = totalDataCw * 8;
  for (let i = 0; i < 4 && bits.length < maxBits; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const dataCw = new Uint8Array(totalDataCw);
  for (let i = 0; i < bits.length / 8; i++) {
    let v = 0;
    for (let b = 0; b < 8; b++) v = (v << 1) | bits[i * 8 + b];
    dataCw[i] = v;
  }
  const pads = [0xec, 0x11];
  for (let i = bits.length / 8, p = 0; i < totalDataCw; i++, p ^= 1) {
    dataCw[i] = pads[p];
  }

  // Split blocks & compute EC
  const dataBlocks = [];
  const ecBlocks = [];
  let offset = 0;
  for (let b = 0; b < g1Blocks; b++) {
    const slice = dataCw.slice(offset, offset + g1Cw);
    offset += g1Cw;
    dataBlocks.push(slice);
    ecBlocks.push(rsRemainder(slice, ecLen));
  }
  for (let b = 0; b < g2Blocks; b++) {
    const slice = dataCw.slice(offset, offset + g2Cw);
    offset += g2Cw;
    dataBlocks.push(slice);
    ecBlocks.push(rsRemainder(slice, ecLen));
  }

  const interleaved = [];
  const maxBlockLen = Math.max(g1Cw, g2Cw);
  for (let i = 0; i < maxBlockLen; i++) {
    for (const blk of dataBlocks) if (i < blk.length) interleaved.push(blk[i]);
  }
  for (let i = 0; i < ecLen; i++) {
    for (const blk of ecBlocks) interleaved.push(blk[i]);
  }

  const size = ver * 4 + 17;
  const modules = Array.from({ length: size }, () => new Uint8Array(size));
  const isFunc = Array.from({ length: size }, () => new Uint8Array(size));

  const setFunc = (r, c, dark) => {
    if (r < 0 || r >= size || c < 0 || c >= size) return;
    modules[r][c] = dark ? 1 : 0;
    isFunc[r][c] = 1;
  };

  const drawFinder = (r0, c0) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const dark =
          dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6 &&
          (dr === 0 || dr === 6 || dc === 0 || dc === 6 || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
        setFunc(r0 + dr, c0 + dc, dark);
      }
    }
  };

  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  for (let i = 8; i < size - 8; i++) {
    setFunc(6, i, i % 2 === 0);
    setFunc(i, 6, i % 2 === 0);
  }

  const align = ALIGNMENT_POS[ver];
  for (const ar of align) {
    for (const ac of align) {
      if ((ar === 6 && ac === 6) || (ar === 6 && ac === size - 7) || (ar === size - 7 && ac === 6)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          setFunc(ar + dr, ac + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
        }
      }
    }
  }

  // Reserve format info & dark module
  for (let i = 0; i <= 8; i++) {
    if (i !== 6) {
      isFunc[8][i] = 1;
      isFunc[i][8] = 1;
    }
  }
  for (let i = 0; i < 8; i++) {
    isFunc[8][size - 1 - i] = 1;
    isFunc[size - 1 - i][8] = 1;
  }
  setFunc(size - 8, 8, true);

  // Place data bits zigzag
  const allBits = [];
  for (const cw of interleaved) {
    for (let b = 7; b >= 0; b--) allBits.push((cw >> b) & 1);
  }

  let bitIdx = 0;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      const r = upward ? size - 1 - vert : vert;
      for (let j = 0; j < 2; j++) {
        const c = right - j;
        if (!isFunc[r][c]) {
          const dark = bitIdx < allBits.length ? allBits[bitIdx++] === 1 : false;
          // Apply mask 0: (r + c) % 2 === 0
          modules[r][c] = dark !== ((r + c) % 2 === 0) ? 1 : 0;
        }
      }
    }
    upward = !upward;
  }

  // Write format info for mask 0
  const fmt = bchFormatInfo(0);
  for (let i = 0; i <= 5; i++) modules[8][i] = (fmt >> (14 - i)) & 1;
  modules[8][7] = (fmt >> 8) & 1;
  modules[8][8] = (fmt >> 7) & 1;
  modules[7][8] = (fmt >> 6) & 1;
  for (let i = 9; i < 15; i++) modules[14 - i][8] = (fmt >> (14 - i)) & 1;

  for (let i = 0; i < 8; i++) modules[8][size - 1 - i] = (fmt >> i) & 1;
  for (let i = 8; i < 15; i++) modules[size - 15 + i][8] = (fmt >> i) & 1;

  return { size, modules };
}

export function renderQrSvg(text, pixelSize = 220) {
  const { size, modules } = encodeQrMatrix(text);
  const border = 3;
  const total = size + border * 2;
  let pathD = "";
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (modules[r][c]) {
        pathD += `M${c + border},${r + border}h1v1h-1z`;
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${pixelSize}" height="${pixelSize}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#ffffff" rx="2"/><path d="${pathD}" fill="#0f172a"/></svg>`;
}
