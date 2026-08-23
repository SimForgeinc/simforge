import { gunzip, gzip } from "node:zlib";
import { promisify } from "node:util";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export async function gzipUtf8(text: string): Promise<Buffer> {
  return gzipAsync(Buffer.from(text, "utf8"));
}

export async function gunzipToUtf8(bytes: Uint8Array): Promise<string> {
  const out = await gunzipAsync(Buffer.from(bytes));
  return out.toString("utf8");
}

export async function gunzipToBytes(bytes: Uint8Array): Promise<Uint8Array> {
  const out = await gunzipAsync(Buffer.from(bytes));
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

export async function gunzipToUtf8Bounded(
  bytes: Uint8Array,
  maximumOutputBytes: number,
): Promise<string> {
  const output = await new Promise<Buffer>((resolve, reject) => {
    gunzip(
      Buffer.from(bytes),
      { maxOutputLength: maximumOutputBytes },
      (error, result) => error ? reject(error) : resolve(result),
    );
  });
  return output.toString("utf8");
}
