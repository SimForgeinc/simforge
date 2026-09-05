import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { HifiPreviewFailure, resolveNativeReadyMap } from "../native-ready-map";

const MAP_ID = "receipt-backed-map";
const RELEASE_DIGEST = "a".repeat(64);
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

describe("native-ready map resolution", () => {
  it("rejects a corpus without the immutable installation receipt", async () => {
    const root = await mkdtemp(join(tmpdir(), "simforge-native-missing-receipt-"));
    try {
      await assert.rejects(
        resolveNativeReadyMap({ mapId: MAP_ID, releaseDigest: RELEASE_DIGEST, corpusRoot: root }),
        (error: unknown) => {
          assert.ok(error instanceof HifiPreviewFailure);
          assert.equal(error.code, "native_payload_unavailable");
          return true;
        },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns the complete checksum-verified master closure", async () => {
    const root = await mkdtemp(join(tmpdir(), "simforge-native-ready-"));
    const master = JSON.stringify({
      asset: { version: "2.0" },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      accessors: [{ min: [0, 0, 0], max: [1, 1, 1] }],
      buffers: [{ uri: "geometry.bin", byteLength: 4 }],
    });
    const corpusDir = join(root, MAP_ID);
    const geometry = Buffer.from([1, 2, 3, 4]);
    try {
      await mkdir(corpusDir, { recursive: true });
      await writeFile(join(corpusDir, "master.gltf"), master);
      await writeFile(join(corpusDir, "geometry.bin"), geometry);
      await writeFile(join(corpusDir, ".map-release.json"), JSON.stringify({
        schema: "simforge.map-installation.v1",
        name: MAP_ID,
        version: "v1",
        releaseDigest: RELEASE_DIGEST,
        canonicalDigest: "b".repeat(64),
        profile: "native",
        members: {
          "master.gltf": { sha256: digest(master), bytes: Buffer.byteLength(master) },
          "geometry.bin": { sha256: digest(geometry), bytes: geometry.byteLength },
        },
      }));

      const resolved = await resolveNativeReadyMap({
        mapId: MAP_ID,
        releaseDigest: RELEASE_DIGEST,
        corpusRoot: root,
      });
      assert.equal(resolved.corpusDir, corpusDir);
      assert.equal(resolved.masterPath, join(corpusDir, "master.gltf"));
      assert.equal(resolved.mapDigest, RELEASE_DIGEST);
      assert.deepEqual(resolved.payloads.map(({ relativePath, sha256, sizeBytes }) => ({ relativePath, sha256, sizeBytes })), [
        { relativePath: "geometry.bin", sha256: digest(geometry), sizeBytes: geometry.byteLength },
        { relativePath: "master.gltf", sha256: digest(master), sizeBytes: Buffer.byteLength(master) },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
