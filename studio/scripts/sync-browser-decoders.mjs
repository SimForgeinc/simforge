import { copyFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Runtime code belongs to the application, not every immutable map closure.
// Copy the JS/WASM pair from the same installed Three release as the loader.
const require = createRequire(import.meta.url);
const source = join(dirname(require.resolve("three")), "../examples/jsm/libs/basis");
const destination = fileURLToPath(new URL("../public/basis/", import.meta.url));
await mkdir(destination, { recursive: true });
await Promise.all(["basis_transcoder.js", "basis_transcoder.wasm"].map((file) =>
  copyFile(join(source, file), join(destination, file)),
));
