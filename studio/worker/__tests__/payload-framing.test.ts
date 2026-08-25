import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { boundsCorners, computePayloadWorldBounds, framePayload, type WorldBounds } from "../payload-framing";
import { MIN_PREVIEW_COVERAGE, renderWithCoverageFallback } from "../preview-coverage";

function glbWithJson(document: object): Buffer {
  const source = Buffer.from(JSON.stringify(document), "utf8");
  const paddedLength = Math.ceil(source.length / 4) * 4;
  const json = Buffer.alloc(paddedLength, 0x20);
  source.copy(json);
  const glb = Buffer.alloc(20 + paddedLength);
  glb.write("glTF", 0, "ascii");
  glb.writeUInt32LE(2, 4);
  glb.writeUInt32LE(glb.length, 8);
  glb.writeUInt32LE(paddedLength, 12);
  glb.writeUInt32LE(0x4e4f534a, 16);
  json.copy(glb, 20);
  return glb;
}

describe("payload world bounds", () => {
  it("composes translated, rotated, and scaled glTF nodes", async () => {
    const root = await mkdtemp(join(tmpdir(), "simforge-framing-test-"));
    const fixture = join(root, "transformed.glb");
    try {
      await writeFile(fixture, glbWithJson({
        asset: { version: "2.0" },
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [{
          mesh: 0,
          translation: [10, 20, 30],
          rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2],
          scale: [2, 3, 4],
        }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
        accessors: [{ min: [0, 0, 0], max: [1, 2, 3] }],
      }));
      const bounds = await computePayloadWorldBounds([fixture]);
      assert.notDeepEqual(bounds, { min: [0, 0, 0], max: [1, 2, 3] }, "must not return local accessor bounds");
      for (let axis = 0; axis < 3; axis += 1) {
        assert.ok(Math.abs(bounds.min[axis] - [4, 20, 30][axis]) < 1e-9);
        assert.ok(Math.abs(bounds.max[axis] - [10, 22, 42][axis]) < 1e-9);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("framePayload", () => {
  it("places all eight bounds corners inside the perspective frustum", () => {
    const bounds: WorldBounds = { min: [-100, -4, 210], max: [260, 18, 570] };
    const aspect = 16 / 9;
    const fovYDeg = 58;
    const camera = framePayload(bounds, aspect, fovYDeg);
    const tanY = Math.tan((fovYDeg * Math.PI) / 360);
    const tanX = tanY * aspect;
    const forwardRaw = camera.target.map((value, axis) => value - camera.eye[axis]) as [number, number, number];
    const forwardLength = Math.hypot(...forwardRaw);
    const forward = forwardRaw.map((value) => value / forwardLength) as [number, number, number];
    const rightLength = Math.hypot(forward[2], forward[0]);
    const right: [number, number, number] = [-forward[2] / rightLength, 0, forward[0] / rightLength];
    const up: [number, number, number] = [
      right[1] * forward[2] - right[2] * forward[1],
      right[2] * forward[0] - right[0] * forward[2],
      right[0] * forward[1] - right[1] * forward[0],
    ];
    for (const corner of boundsCorners(bounds)) {
      const offset = corner.map((value, axis) => value - camera.eye[axis]) as [number, number, number];
      const depth = offset[0] * forward[0] + offset[1] * forward[1] + offset[2] * forward[2];
      const x = offset[0] * right[0] + offset[1] * right[1] + offset[2] * right[2];
      const y = offset[0] * up[0] + offset[1] * up[1] + offset[2] * up[2];
      assert.ok(depth > 0, "corner must be in front of camera");
      assert.ok(Math.abs(x) < depth * tanX, "corner must fit horizontal FOV");
      assert.ok(Math.abs(y) < depth * tanY, "corner must fit vertical FOV");
    }
  });
});

describe("preview coverage policy", () => {
  const bounds: WorldBounds = { min: [0, 0, 0], max: [10, 2, 20] };
  const requested = { eye: [0, 10, 0] as [number, number, number], target: [0, 10, -1] as [number, number, number] };
  const framed = framePayload(bounds, 16 / 9, 58);

  it("throws typed camera_sees_nothing below the 0.5% threshold", async () => {
    await assert.rejects(
      renderWithCoverageFallback({
        requestedCamera: requested,
        framedCamera: framed,
        worldBounds: bounds,
        render: async () => ({ coverage: MIN_PREVIEW_COVERAGE / 2 }),
      }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "camera_sees_nothing");
        assert.deepEqual((error as { detail?: { worldBounds?: WorldBounds } }).detail?.worldBounds, bounds);
        return true;
      },
    );
  });

  it("retries zero coverage once and records fallback provenance", async () => {
    const attempts: string[] = [];
    const result = await renderWithCoverageFallback({
      requestedCamera: requested,
      framedCamera: framed,
      worldBounds: bounds,
      render: async (_camera, attempt) => {
        attempts.push(attempt);
        return { coverage: attempt === "requested" ? 0 : 0.42, token: "frame" };
      },
    });
    assert.deepEqual(attempts, ["requested", "framed"]);
    assert.equal(result.fallbackFraming, true);
    assert.deepEqual(result.camera, framed);
    assert.equal(result.coverage, 0.42);
  });
});
