import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

import { parsePlaybackPair } from "@simforge/playback";
import type { RenderInputFile } from "@simforge/render";
import { hashFile } from "@simforge/render";
import { contentHash, parseSimScenarioInput } from "@simforge/engine";

import { executeRender } from "./executor.js";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const DEFAULT_FIXTURE = resolve(
  REPOSITORY_ROOT,
  "catalog/evidence/yale-street/yale-street-007-multiple-threat-crosswalk-585ad30557a6/instance.json",
);

async function main(argv: readonly string[]): Promise<void> {
  const args = argumentsOf(argv);
  const instancePath = resolve(args.instance ?? DEFAULT_FIXTURE);
  const tracePath = resolve(args.trace ?? join(dirname(instancePath), "trace.json.gz"));
  const devAssets = resolve(args.devAssets ?? process.env.SCEN_DEV_ASSETS ?? "/home/path/UniScenarios/dev-assets");
  const output = resolve(args.output ?? "/tmp/uniscenarios-cloud-worker-harness");
  process.env.UNISCENARIOS_BROWSER_ENGINE_MODULE ??= pathToFileURL(
    resolve(REPOSITORY_ROOT, "packages/render/dist/index.js"),
  ).href;
  await rm(output, { recursive: true, force: true });

  const instance = JSON.parse(await readFile(instancePath, "utf8")) as Record<string, unknown> & {
    input?: { mapId?: unknown; clipSeconds?: unknown; metricSubject?: unknown };
    manifest?: Record<string, unknown>;
  };
  const traceBytes = await readFile(tracePath);
  const trace = JSON.parse(gunzipSync(traceBytes).toString("utf8")) as {
    header?: Record<string, unknown>;
  };
  // Catalog evidence predates the current schema defaults. Re-parse the unchanged maneuver and
  // refresh only its derived identity fields so the current playback runtime can verify it.
  const currentInput = parseSimScenarioInput(instance.input);
  instance.input = currentInput;
  const currentInputHash = contentHash(currentInput);
  if (instance.manifest) instance.manifest.inputHash = currentInputHash;
  if (trace.header) trace.header.inputHash = currentInputHash;
  delete instance.catalogSlot;
  if (trace.header) delete trace.header.catalogSlot;
  const bundle = parsePlaybackPair(instance, trace, {
    instanceName: instancePath,
    traceName: tracePath,
  });
  const hostActorId = typeof instance.input?.metricSubject === "string"
    ? instance.input.metricSubject
    : bundle.actors.find((actor) => actor.kind !== "pedestrian")?.id;
  if (!hostActorId) throw new Error("scenario fixture has no vehicle actor for the Pronto sensor host");
  const mapId = instance.input?.mapId;
  if (typeof mapId !== "string") throw new Error("scenario fixture is missing input.mapId");
  const clipSeconds = instance.input?.clipSeconds;
  if (typeof clipSeconds !== "number" || clipSeconds <= 0) throw new Error("scenario fixture has invalid input.clipSeconds");

  const playback = {
    ...bundle,
    actors: bundle.actors.map((actor) => actor.id === hostActorId
      ? { ...actor, catalogId: "vehicle.kia.carnival" }
      : actor),
  };
  const playbackPath = join(output, "inputs", "playback-bundle.json");
  const mapManifestPath = join(devAssets, mapId, "3d", "manifest.json");
  const xoscPath = join(output, "inputs", "scenario.xosc");
  await mkdir(dirname(playbackPath), { recursive: true, mode: 0o700 });
  await writeFile(playbackPath, `${JSON.stringify(playback)}\n`, { mode: 0o600 });
  await writeFile(xoscPath, minimalOpenScenario(hostActorId, mapId), { mode: 0o600 });

  const inputEntries = await Promise.all([
    inputFile("scenario.xosc", xoscPath),
    inputFile("map.manifest", mapManifestPath),
    inputFile("playback.bundle", playbackPath),
  ]);
  const inputs = new Map(inputEntries.map((input) => [input.inputId, input]));
  const xosc = inputs.get("scenario.xosc")!;
  const map = inputs.get("map.manifest")!;
  const playbackInput = inputs.get("playback.bundle")!;
  const intent = {
    schema: "uniscenario.render-intent/v1",
    intentId: "cloud-worker-harness",
    executionPackage: {
      id: "cloud-worker-harness-package",
      sourceInputDigest: digestString(`${instancePath}\0${tracePath}`),
    },
    scenarioRevision: {
      revisionId: "cloud-worker-harness-revision",
      scenarioSha256: xosc.sha256,
      openScenario: { sha256: xosc.sha256, sizeBytes: xosc.sizeBytes },
      map: { mapId, revisionId: `${mapId}-local`, sha256: map.sha256 },
    },
    sensorHost: {
      actorId: hostActorId,
      vehicleAsset: {
        catalogAssetId: "vehicle.kia.carnival",
        carlaBlueprintId: "vehicle.kia.carnival",
        carlaClassPath: "/Game/Carla/Blueprints/Vehicles/KiaCarnival2025/BP_KiaCarnival2025.BP_KiaCarnival2025_C",
        make: "Kia",
        model: "Carnival",
        baseType: "van",
        sourceImage: {
          repository: "ghcr.io/simforgeinc/carla-rfs-munich-belmont",
          indexSha256: "f17c639e5f86fd7458fe1d02d3be1d481deeaa714f3cac30e465187d04ec90e5",
          linuxAmd64ManifestSha256: "baed0d038437c55efe0abe52a762d352aeb21acdeeff5b11a15f6bd8a648de64",
        },
      },
      sensorRig: { rigId: "pronto.8-camera-6-lidar-4-radar", cameras: 8, lidars: 6, radars: 4 },
    },
    renderSpec: {
      schema: "uniscenario.render-spec/v3",
      sources: prontoSources(hostActorId),
      clip: { startSeconds: 0, endSeconds: Math.min(clipSeconds, 1 / 24) },
      video: { width: 320, height: 180, fps: 24, container: "mp4", codec: "h264", quality: "draft" },
      artifacts: ["manifest", "video", "sensorArchive"],
      capabilityIntent: {
        required: ["sensor.rgb", "sensor.lidar", "sensor.radar", "artifact.video", "artifact.manifest", "artifact.sensor_archive", "artifact.sensor_video"],
        preferred: [],
        fidelity: "review",
      },
      authoredEnvironment: {
        weather: "clear",
        timeOfDay: "noon",
        sunAzimuthDeg: 180,
        sunElevationDeg: 60,
        surfacePatches: [],
      },
    },
    assets: [
      { assetId: "map.manifest", kind: "map", sha256: map.sha256, sizeBytes: map.sizeBytes },
      { assetId: "playback.bundle", kind: "other", sha256: playbackInput.sha256, sizeBytes: playbackInput.sizeBytes },
    ],
    seed: 1,
  };

  const result = await executeRender({
    jobId: "cloud-worker-harness",
    attempt: 1,
    engine: "browser",
    intent,
    inputs,
    workspace: output,
    signal: new AbortController().signal,
  });
  const sensorVideos = result.artifacts.filter((artifact) => artifact.kind === "sensor_video");
  if (sensorVideos.length !== 18) {
    throw new Error(`worker harness expected 18 per-sensor videos, received ${sensorVideos.length}`);
  }
  process.stdout.write(`${JSON.stringify({
    output,
    manifest: result.artifacts.find((artifact) => artifact.kind === "manifest")?.path,
    mp4: result.artifacts.find((artifact) => artifact.kind === "video")?.path,
    durationSeconds: result.durationSeconds,
    frameCount: result.frameCount,
    sensorVideos: sensorVideos.length,
    sourceFixture: instancePath,
    mapManifest: mapManifestPath,
  })}\n`);
}

async function inputFile(inputId: string, path: string): Promise<RenderInputFile> {
  const digest = await hashFile(path);
  return { inputId, path, ...digest };
}

function prontoSources(actorId: string): Array<Record<string, unknown>> {
  const zeroMount = () => ({
    position: { x: 0.8, y: 1.8, z: 0 },
    rotation: { yawRad: 0, pitchRad: 0, rollRad: 0 },
  });
  const cameras = Array.from({ length: 8 }, (_, index) => ({
    actorId,
    sensorId: `pronto-cam${index}`,
    outputName: `pronto-cam${index}-rgb`,
    transform: zeroMount(),
    modality: "rgb",
    attributes: { width: 320, height: 180, fps: 24, horizontalFovDeg: index === 3 ? 30 : 90, nearM: 0.05, farM: 1_000 },
  }));
  const lidars = Array.from({ length: 6 }, (_, index) => ({
    actorId,
    sensorId: `pronto-lidar-${index}`,
    outputName: `pronto-lidar-${index}-lidar`,
    transform: zeroMount(),
    modality: "lidar",
    attributes: { channels: 2, rangeM: 30, pointsPerSecond: 24, rotationFrequencyHz: 24, upperFovDeg: 5, lowerFovDeg: -5 },
  }));
  const radars = Array.from({ length: 4 }, (_, index) => ({
    actorId,
    sensorId: `pronto-radar-${index}`,
    outputName: `pronto-radar-${index}-radar`,
    transform: zeroMount(),
    modality: "radar",
    attributes: { horizontalFovDeg: 30, verticalFovDeg: 20, rangeM: 30, pointsPerSecond: 24 },
  }));
  return [...cameras, ...lidars, ...radars];
}

function minimalOpenScenario(actorId: string, mapId: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<OpenSCENARIO><FileHeader revMajor="1" revMinor="4" date="2026-08-22T00:00:00Z" description="UniScenarios cloud worker harness" author="UniScenarios"><Properties><Property name="uniscenarios.provenance.inputHash" value="${digestString(`${actorId}\0${mapId}`)}"/></Properties></FileHeader><Entities><ScenarioObject name="${actorId}"><Vehicle name="vehicle.kia.carnival" vehicleCategory="van"><BoundingBox><Center x="0" y="0" z="0.9"/><Dimensions width="2" length="5" height="1.8"/></BoundingBox><Performance maxSpeed="50" maxAcceleration="5" maxDeceleration="8"/><Axles><FrontAxle maxSteering="0.5" wheelDiameter="0.7" trackWidth="1.7" positionX="1.5" positionZ="0.35"/><RearAxle maxSteering="0" wheelDiameter="0.7" trackWidth="1.7" positionX="-1.5" positionZ="0.35"/></Axles><Properties/></Vehicle></ScenarioObject></Entities><Storyboard><Init><Actions/></Init><Story name="harness"/></Storyboard></OpenSCENARIO>\n`;
}

function digestString(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}


function argumentsOf(argv: readonly string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || !value) throw new Error("usage: harness [--instance path --trace path --dev-assets path --output path]");
    values[flag.slice(2)] = value;
  }
  return values;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
