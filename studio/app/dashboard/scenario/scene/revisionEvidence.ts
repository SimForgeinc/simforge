import {
  contentHash,
  createDisabledMaterializedTrafficArtifact,
  MaterializedTrafficRecorder,
  type MaterializedTrafficArtifactEnvelope,
  type MaterializedTrafficFrameActor,
  type ResolvedAmbientTrafficProfile,
} from "@simforge-oss/engine";
import { EMPTY_AMBIENT_CONFIG_SHA256, type ScenarioAmbientProvenance } from "@/app/lib/scenario/contracts";
import type { MapEntry } from "@/app/lib/scenario/maps";
import type { PlaybackBundle } from "@simforge-oss/playback";
import type { AmbientTrafficProviderId } from "@simforge-oss/playback/traffic";

/** Build deterministic renderer/off traffic bytes only after an explicit export/render action. */
export function materializeBrowserRevisionTraffic(
  provider: Exclude<AmbientTrafficProviderId, "sumo">,
  profile: ResolvedAmbientTrafficProfile,
  map: MapEntry,
  bundle: PlaybackBundle,
): MaterializedTrafficArtifactEnvelope {
  if (provider === "off") {
    return createDisabledMaterializedTrafficArtifact({
      sourceInputDigest: bundle.instance.manifest.inputHash,
      map: { assetId: map.sourceMapId, versionId: map.mapVersionId },
      fixedStepSeconds: bundle.trace.header.dt,
      durationSeconds: bundle.endTime - bundle.startTime,
    });
  }

  const recorder = new MaterializedTrafficRecorder({
    sourceInputDigest: bundle.instance.manifest.inputHash,
    map: { assetId: map.sourceMapId, versionId: map.mapVersionId },
    provider: {
      id: "native",
      version: bundle.trace.header.engineVersion,
      seed: String(profile.seed),
    },
    fixedStepSeconds: bundle.trace.header.dt,
    durationSeconds: bundle.endTime - bundle.startTime,
  });
  const metadata = new Map(bundle.actors.map((actor) => [actor.id, actor]));
  const ambientIds = [...new Set(bundle.ambientTraffic?.actors.map((actor) => actor.id) ?? [])].sort();
  for (let index = 0; index < bundle.trace.ticks.t.length; index += 1) {
    const actors: MaterializedTrafficFrameActor[] = [];
    for (const actorId of ambientIds) {
      const track = bundle.trace.ticks.actors[actorId];
      const actor = metadata.get(actorId);
      if (!track || !actor || track.present[index] !== 1) continue;
      actors.push({
        id: actorId,
        kind: materializedActorKind(actor.kind),
        x: track.x[index]!,
        z: track.z[index]!,
        headingRad: track.headingRad[index]!,
        speedMps: track.speedMps[index]!,
        accelerationMps2: 0,
        signals: 0,
      });
    }
    const signals = Object.fromEntries(
      Object.entries(bundle.trace.ticks.signals ?? {}).map(([signalId, track]) => [
        signalId,
        materializedSignalState(track.phase[index] ?? "off"),
      ]),
    );
    recorder.record({ t: bundle.trace.ticks.t[index]!, actors, signals });
  }
  return recorder.finalize();
}

export function ambientProvenanceForRevisionTraffic(
  artifact: MaterializedTrafficArtifactEnvelope,
  profile: ResolvedAmbientTrafficProfile,
  map: MapEntry,
): ScenarioAmbientProvenance {
  const provider = artifact.artifact.provider;
  if (provider.id === "disabled") {
    return {
      mode: "disabled",
      ambientConfig: {},
      configSha256: EMPTY_AMBIENT_CONFIG_SHA256,
      resultSha256: artifact.sha256,
    };
  }
  if (provider.id === "sumo") {
    if (!map.sumoNetworkSha256) throw new Error("SUMO traffic evidence requires an immutable network digest.");
    return {
      mode: "sumo",
      sumoVersion: provider.version,
      networkSha256: map.sumoNetworkSha256,
      seed: provider.seed,
      ambientConfig: profile,
      configSha256: contentHash(profile),
      resultSha256: artifact.sha256,
    };
  }
  return {
    mode: "native",
    runtimeVersion: provider.version,
    seed: provider.seed,
    ambientConfig: profile,
    configSha256: contentHash(profile),
    resultSha256: artifact.sha256,
  };
}

function materializedActorKind(kind: string): MaterializedTrafficFrameActor["kind"] {
  if (kind === "pedestrian") return "pedestrian";
  if (kind === "bicycle" || kind === "scooter") return "bicycle";
  if (["vehicle", "car", "truck", "bus", "van", "motorcycle"].includes(kind)) return "vehicle";
  return "obstacle";
}

function materializedSignalState(state: string): "green" | "yellow" | "red" | "off" {
  if (state === "green" || state === "proceed" || state === "green_arrow") return "green";
  if (state === "yellow" || state === "flashing_yellow" || state === "yellow_arrow") return "yellow";
  if (state === "red" || state === "stop" || state === "flashing_red" || state === "red_x") return "red";
  return "off";
}
