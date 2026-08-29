import type { PlaybackBundle } from '@simforge-oss/playback';
import type { RenderSensorSourceHost, RenderSpecV3 } from '@simforge-oss/scenario';

/** Browser-side defense after portable schema validation and input materialization. */
export function assertBrowserSensorHosts(
  renderSpec: RenderSpecV3,
  bundle: PlaybackBundle,
  sensorHosts: readonly RenderSensorSourceHost[],
): void {
  const hostBySourceId = new Map<string, RenderSensorSourceHost>();
  for (const host of sensorHosts) {
    if (hostBySourceId.has(host.sourceId)) {
      throw new Error(`Browser sensor host mapping repeats source ${host.sourceId}.`);
    }
    hostBySourceId.set(host.sourceId, host);
  }
  if (hostBySourceId.size !== renderSpec.sources.length) {
    throw new Error('Browser sensor host mappings must cover every render source exactly once.');
  }
  for (const source of renderSpec.sources) {
    const host = hostBySourceId.get(source.outputName);
    if (!host) throw new Error(`Browser render source ${source.outputName} has no sensor host mapping.`);
    if (host.actorId !== source.actorId) {
      throw new Error(`Browser sensor host for ${source.outputName} does not match actor ${source.actorId}.`);
    }
    const actor = bundle.actors.find((candidate) => candidate.id === host.actorId);
    if (!actor) throw new Error(`Browser sensor host ${host.actorId} is absent from immutable playback metadata.`);
  }
}
