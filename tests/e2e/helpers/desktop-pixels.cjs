/* Pixel compare for the 1280 desktop pictures.

   Playwright's screenshot threshold is a perceptual distance. It cannot
   express "at most one level per channel". This compare does.

   A level is one step of 0–255 in red, green, blue, or alpha. maxDelta
   is the largest of those four gaps on any pixel. overOne counts pixels
   whose gap is 2 or more. diffPixels counts pixels that are not equal. */
const { inflateSync } = require("node:zlib");

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function paeth(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const dl = Math.abs(estimate - left);
  const du = Math.abs(estimate - up);
  const dul = Math.abs(estimate - upLeft);
  if (dl <= du && dl <= dul) return left;
  if (du <= dul) return up;
  return upLeft;
}

function unfilter(filter, row, previous, bytesPerPixel) {
  if (filter === 0) return;
  for (let i = 0; i < row.length; i++) {
    const left = i >= bytesPerPixel ? row[i - bytesPerPixel] : 0;
    const up = previous[i];
    const upLeft = i >= bytesPerPixel ? previous[i - bytesPerPixel] : 0;
    let predicted = 0;
    if (filter === 1) predicted = left;
    else if (filter === 2) predicted = up;
    else if (filter === 3) predicted = Math.floor((left + up) / 2);
    else if (filter === 4) predicted = paeth(left, up, upLeft);
    else throw new Error(`unsupported PNG filter ${filter}`);
    row[i] = (row[i] + predicted) & 255;
  }
}

/* 8-bit, non-interlaced PNG to a tightly packed RGBA buffer. */
function decodePng(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("not a PNG");
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let interlace = 0;
  const idat = [];
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
  }
  if (bitDepth !== 8 || interlace !== 0) {
    throw new Error(`unsupported PNG bitDepth=${bitDepth} interlace=${interlace}`);
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`unsupported PNG colour type ${colorType}`);
  const inflated = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const expected = height * (1 + stride);
  if (inflated.length < expected) throw new Error("PNG image data is short");
  const rgba = Buffer.alloc(width * height * 4);
  let cursor = 0;
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = inflated[cursor];
    cursor += 1;
    const row = Buffer.from(inflated.subarray(cursor, cursor + stride));
    cursor += stride;
    unfilter(filter, row, previous, channels);
    for (let x = 0; x < width; x++) {
      const source = x * channels;
      const dest = (y * width + x) * 4;
      if (colorType === 6) {
        rgba[dest] = row[source];
        rgba[dest + 1] = row[source + 1];
        rgba[dest + 2] = row[source + 2];
        rgba[dest + 3] = row[source + 3];
      } else if (colorType === 2) {
        rgba[dest] = row[source];
        rgba[dest + 1] = row[source + 1];
        rgba[dest + 2] = row[source + 2];
        rgba[dest + 3] = 255;
      } else if (colorType === 0) {
        rgba[dest] = rgba[dest + 1] = rgba[dest + 2] = row[source];
        rgba[dest + 3] = 255;
      } else {
        rgba[dest] = rgba[dest + 1] = rgba[dest + 2] = row[source];
        rgba[dest + 3] = row[source + 1];
      }
    }
    previous = row;
  }
  return { width, height, data: rgba };
}

function diffRgba(actual, expected) {
  if (actual.length !== expected.length || actual.length % 4 !== 0) {
    throw new Error("RGBA buffers differ in length");
  }
  let diffPixels = 0;
  let maxDelta = 0;
  let overOne = 0;
  for (let i = 0; i < actual.length; i += 4) {
    const delta = Math.max(
      Math.abs(actual[i] - expected[i]),
      Math.abs(actual[i + 1] - expected[i + 1]),
      Math.abs(actual[i + 2] - expected[i + 2]),
      Math.abs(actual[i + 3] - expected[i + 3]),
    );
    if (delta === 0) continue;
    diffPixels += 1;
    if (delta > maxDelta) maxDelta = delta;
    if (delta > 1) overOne += 1;
  }
  return { diffPixels, maxDelta, overOne };
}

module.exports = { decodePng, diffRgba };
