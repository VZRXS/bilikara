// Bounded PNG inspection for build assets, independent of platform UI/Runtime.
// Tauri's icons and sips-normalized asset-catalog PNGs are 8-bit RGB/RGBA.
import {crc32, inflateSync} from 'node:zlib';

export function pngRgba(bytes) {
  const invalid = () => {throw Error('ios_icon_png_invalid');};
  if (bytes.length > 20 * 1024 * 1024 || !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) invalid();
  let width, height, channels, end = false;
  const payload = [];
  for (let offset = 8; offset < bytes.length;) {
    if (offset + 12 > bytes.length || end) invalid();
    const size = bytes.readUInt32BE(offset), stop = offset + 12 + size;
    if (stop > bytes.length || crc32(bytes.subarray(offset + 4, stop - 4)) !== bytes.readUInt32BE(stop - 4)) invalid();
    const type = bytes.toString('ascii', offset + 4, offset + 8), data = bytes.subarray(offset + 8, stop - 4);
    if (!/^[A-Za-z]{4}$/.test(type)) invalid();
    if (offset === 8 && type !== 'IHDR') invalid();
    if (type === 'IHDR') {
      if (width !== undefined || size !== 13) invalid();
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      if (!width || !height || width > 2048 || height > 2048 || data[8] !== 8
          || ![2, 6].includes(data[9]) || data[10] || data[11] || data[12]) invalid();
      channels = data[9] === 2 ? 3 : 4;
    } else if (type === 'IDAT') payload.push(data);
    else if (type === 'IEND') {if (size !== 0) invalid(); end = true;}
    else if (type === 'tRNS' || type === 'CgBI' || type === 'acTL') invalid();
    else if ((type.charCodeAt(0) & 32) === 0 && type !== 'PLTE') invalid();
    offset = stop;
  }
  if (!end || !payload.length) invalid();
  const stride = width * channels, expected = (stride + 1) * height;
  const raw = inflateSync(Buffer.concat(payload), {maxOutputLength: expected});
  if (raw.length !== expected) invalid();
  const pixels = Buffer.alloc(width * height * 4);
  let previous = Buffer.alloc(stride);
  const paeth = (a, b, c) => {
    const p = a + b - c, x = Math.abs(p - a), y = Math.abs(p - b), z = Math.abs(p - c);
    return x <= y && x <= z ? a : y <= z ? b : c;
  };
  for (let row = 0; row < height; row++) {
    const filter = raw[row * (stride + 1)], current = Buffer.allocUnsafe(stride);
    if (filter > 4) invalid();
    for (let index = 0; index < stride; index++) {
      const left = index >= channels ? current[index - channels] : 0;
      const above = previous[index], corner = index >= channels ? previous[index - channels] : 0;
      const predictor = [0, left, above, Math.floor((left + above) / 2), paeth(left, above, corner)][filter];
      current[index] = (raw[row * (stride + 1) + index + 1] + predictor) & 255;
    }
    for (let column = 0; column < width; column++) {
      const pixel = (row * width + column) * 4;
      current.copy(pixels, pixel, column * channels, column * channels + 3);
      pixels[pixel + 3] = channels === 4 ? current[column * 4 + 3] : 255;
    }
    previous = current;
  }
  return {width, height, pixels, opaque: pixels.every((value, index) => index % 4 !== 3 || value === 255)};
}
