import type { UniScenarioSimulationPreviewDto } from "@/app/lib/uniscenario/contracts";
import { fetchContentAddressedArtifact } from "@/app/lib/uniscenario/artifact-cache";
import { parsePlaybackPair, type PlaybackBundle } from "@uniscenarios/playback";
// v2 invalidates traces generated before static map colliders were aligned to
// the browser scene frame. Replaying those v1 traces would preserve vehicles
// that had already passed through visible buildings.
const SCHEMA = "simforge.uniscenario-browser-preview/v2";
type Stored = { schema: typeof SCHEMA; draftVersion: number; instance: PlaybackBundle["instance"]; trace: PlaybackBundle["trace"]; ambientTraffic?: PlaybackBundle["ambientTraffic"]; mapCollisions?: PlaybackBundle["mapCollisions"]; openScenario?: PlaybackBundle["openScenario"] };
export async function encodeSimulationPreview(bundle: PlaybackBundle, draftVersion: number) {
  const value: Stored = { schema: SCHEMA, draftVersion, instance: bundle.instance, trace: bundle.trace, ...(bundle.ambientTraffic ? { ambientTraffic: bundle.ambientTraffic } : {}), ...(bundle.mapCollisions ? { mapCollisions: bundle.mapCollisions } : {}), ...(bundle.openScenario ? { openScenario: bundle.openScenario } : {}) };
  const compressed = await new Response(new Blob([JSON.stringify(value)]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
  const bytes = new Uint8Array(compressed); return { bytes, sha256: await sha256Hex(bytes) };
}
export async function downloadSimulationPreview(descriptor: UniScenarioSimulationPreviewDto, signal?: AbortSignal): Promise<PlaybackBundle> {
  // Digest-addressed, so a cache hit is the same bytes by definition; the size
  // and checksum checks that used to live here moved into the cache and now
  // cover reads as well as downloads.
  const bytes = await fetchContentAddressedArtifact(
    descriptor.downloadUrl,
    { sha256: descriptor.sha256, sizeBytes: descriptor.sizeBytes },
    { signal, label: "Saved simulation" },
  );
  const json = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text(); const value = JSON.parse(json) as Partial<Stored>;
  if (value.schema !== SCHEMA || value.draftVersion !== descriptor.draftVersion) throw new Error("Saved simulation does not match this scenario version");
  const base = parsePlaybackPair(value.instance, value.trace, { instanceName: "saved scenario", traceName: "saved simulation" });
  return { ...base, ...(value.ambientTraffic ? { ambientTraffic: value.ambientTraffic } : {}), ...(value.mapCollisions ? { mapCollisions: value.mapCollisions } : {}), ...(value.openScenario ? { openScenario: value.openScenario } : {}) };
}
async function sha256Hex(bytes: Uint8Array) { const digest = await crypto.subtle.digest("SHA-256", bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer); return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join(""); }
