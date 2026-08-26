import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ASSET_PACK_SCHEMA_ID,
  ASSET_PACK_SOURCE_SCHEMA_ID,
  AssetPackManifestSchema,
  buildAssetPack,
} from "./index.js";

describe("buildAssetPack", () => {
  it("copies source bytes and emits a self-consistent versioned manifest", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "simforge-pack-"));
    const sourcePath = path.join(root, "actor.glb");
    const bytes = Buffer.from("glb fixture bytes");
    await writeFile(sourcePath, bytes);
    const configPath = path.join(root, "pack-source.json");
    await writeFile(configPath, JSON.stringify({
      schema: ASSET_PACK_SOURCE_SCHEMA_ID,
      id: "simforge.test",
      version: "1.2.0",
      title: "Test pack",
      author: "SimForge",
      license: "Apache-2.0",
      lane: "browser",
      entries: [{
        id: "pedestrian.test",
        label: "Test pedestrian",
        class: "pedestrian",
        dims: { l: 0.3, w: 0.5, h: 1.7 },
        tags: ["vru"],
        thumbnail: null,
        files: [{
          source: "actor.glb",
          path: "models/actor.glb",
          mediaType: "model/gltf-binary",
        }],
      }],
    }));
    const outDir = path.join(root, "out");

    const manifest = await buildAssetPack({ configPath, outDir });
    const writtenManifest = AssetPackManifestSchema.parse(
      JSON.parse(await readFile(path.join(outDir, "manifest.json"), "utf8")),
    );
    const writtenBytes = await readFile(path.join(outDir, "models/actor.glb"));
    const sha256 = createHash("sha256").update(bytes).digest("hex");

    expect(writtenManifest).toEqual(manifest);
    expect(writtenManifest.schema).toBe(ASSET_PACK_SCHEMA_ID);
    expect(writtenManifest.version).toBe("1.2.0");
    expect(writtenManifest.entries[0]?.files[0]).toEqual({
      path: "models/actor.glb",
      sha256,
      size: bytes.byteLength,
      mediaType: "model/gltf-binary",
    });
    expect(writtenManifest.blobs[sha256]).toEqual({
      size: bytes.byteLength,
      mediaType: "model/gltf-binary",
    });
    expect(writtenBytes).toEqual(bytes);
  });

  it("rejects traversal in a logical pack path", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "simforge-pack-invalid-"));
    await writeFile(path.join(root, "actor.glb"), "bytes");
    const configPath = path.join(root, "pack-source.json");
    await writeFile(configPath, JSON.stringify({
      schema: ASSET_PACK_SOURCE_SCHEMA_ID,
      id: "simforge.test",
      version: "1.0.0",
      title: "Test pack",
      author: "SimForge",
      license: "Apache-2.0",
      lane: "browser",
      entries: [{
        id: "actor.test",
        label: "Actor",
        class: "static_object",
        dims: { l: 1, w: 1, h: 1 },
        tags: [],
        thumbnail: null,
        files: [{ source: "actor.glb", path: "../actor.glb", mediaType: "model/gltf-binary" }],
      }],
    }));

    await expect(buildAssetPack({ configPath, outDir: path.join(root, "out") })).rejects.toThrow();
  });
});
