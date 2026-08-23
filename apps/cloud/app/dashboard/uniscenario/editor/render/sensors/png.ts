import { zlibSync } from "fflate";

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const textEncoder = new TextEncoder();

export function encodePng8Rgba(width: number, height: number, pixels: Uint8Array): Uint8Array {
  assertDimensions(width, height);
  if (pixels.byteLength !== width * height * 4) {
    throw new Error(`RGBA pixel length ${pixels.byteLength} does not match ${width}x${height}.`);
  }
  return encodePng(width, height, 8, 6, scanlines(width, height, 4, pixels));
}

/** Encode unsigned 16-bit grayscale samples. PNG stores every sample big-endian. */
export function encodePng16Gray(width: number, height: number, pixels: Uint16Array): Uint8Array {
  assertDimensions(width, height);
  if (pixels.length !== width * height) {
    throw new Error(`Grayscale pixel length ${pixels.length} does not match ${width}x${height}.`);
  }
  const bytes = new Uint8Array(pixels.length * 2);
  for (let index = 0; index < pixels.length; index += 1) {
    const value = pixels[index] ?? 0;
    bytes[index * 2] = value >>> 8;
    bytes[index * 2 + 1] = value & 0xff;
  }
  return encodePng(width, height, 16, 0, scanlines(width, height, 2, bytes));
}

function encodePng(
  width: number,
  height: number,
  bitDepth: 8 | 16,
  colorType: 0 | 6,
  filtered: Uint8Array,
): Uint8Array {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  // compression, filter, and interlace methods remain zero.
  const compressed = zlibSync(filtered, { level: 9 });
  return concat(PNG_SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", compressed), chunk("IEND", new Uint8Array()));
}

function scanlines(width: number, height: number, bytesPerPixel: number, pixels: Uint8Array): Uint8Array {
  const rowBytes = width * bytesPerPixel;
  const output = new Uint8Array((rowBytes + 1) * height);
  for (let row = 0; row < height; row += 1) {
    const destination = row * (rowBytes + 1);
    output[destination] = 0; // fixed None filter: deterministic and independently decodable.
    output.set(pixels.subarray(row * rowBytes, (row + 1) * rowBytes), destination + 1);
  }
  return output;
}

function chunk(name: string, data: Uint8Array): Uint8Array {
  const type = textEncoder.encode(name);
  const output = new Uint8Array(12 + data.byteLength);
  const view = new DataView(output.buffer);
  view.setUint32(0, data.byteLength);
  output.set(type, 4);
  output.set(data, 8);
  view.setUint32(8 + data.byteLength, crc32(concat(type, data)));
  return output;
}

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function assertDimensions(width: number, height: number): void {
  if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) {
    throw new Error("PNG dimensions must be positive safe integers.");
  }
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}
