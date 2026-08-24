/**
 * Native JPEG encoding through OffscreenCanvas. Only review-fidelity RGB frames
 * use this path; every lossless artifact keeps the deterministic PNG encoder.
 */
export async function encodeJpegRgba(
  width: number,
  height: number,
  pixels: Uint8Array,
  quality = 0.9,
): Promise<Uint8Array> {
  if (pixels.byteLength !== width * height * 4) {
    throw new Error(`RGBA pixel length ${pixels.byteLength} does not match ${width}x${height}.`);
  }
  // JPEG has no alpha channel and canvases store premultiplied pixels, so a
  // transparent readback pixel would otherwise lose its RGB values entirely.
  const opaque = new Uint8ClampedArray(pixels);
  for (let index = 3; index < opaque.length; index += 4) opaque[index] = 255;
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('JPEG encoding requires a 2d OffscreenCanvas context.');
  context.putImageData(new ImageData(opaque, width, height), 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error('OffscreenCanvas did not produce a JPEG stream.');
  }
  return bytes;
}
