import type { ResolvedAmbientTrafficProfile } from "@simforge/engine";
import { ambientTrafficProfileFromExtensions } from "@simforge/playback/traffic";
import {
  ambientTrafficProviderFromExtensions,
} from "@simforge/playback/traffic";
import type { UniScenarioMapEntry } from "@simforge/editor";
import type { UniScenarioMapOption } from "../list/document-map-groups";

/** Playback compilation needs this complete immutable map-sidecar closure. */
export function mapSupportsScenarioPreview(
  map: UniScenarioMapOption,
): map is UniScenarioMapOption & UniScenarioMapEntry {
  return Boolean(
    map.browserManifestUrl
      && map.topologyUrl
      && map.derivedTopologyUrl
      && map.locationsUrl
      && map.id === map.mapVersionId
      && map.versionId === map.mapVersionId
      && map.sourceMapId
      && map.browserAssetRootUrl
      && map.browserClosureSha256
      && map.artifacts
      && map.sumoNetworkSha256 !== undefined,
  );
}

export function previewAmbientTrafficProfile(
  provider: ReturnType<typeof ambientTrafficProviderFromExtensions>,
  extensions: Readonly<Record<string, unknown>> | undefined,
  hasAuthoredMapSignals = false,
): ResolvedAmbientTrafficProfile {
  return previewExecutionTrafficProvider(provider, hasAuthoredMapSignals) === "native"
    ? ambientTrafficProfileFromExtensions(extensions)
    : ambientTrafficProfileFromExtensions({
        "studio.ambientTraffic.profile.v1": {
          version: 1,
          preset: "off",
          seed: "execution-provider-off",
        },
      });
}

/**
 * Authored controllers must be the only signal authority. The browser SUMO
 * bridge cannot inject their tlLogic, so match UniScenario Studio by running
 * native engine traffic—which consumes the compiled signal book—in that case.
 */
export function previewExecutionTrafficProvider(
  provider: ReturnType<typeof ambientTrafficProviderFromExtensions>,
  hasAuthoredMapSignals: boolean,
): ReturnType<typeof ambientTrafficProviderFromExtensions> {
  return provider === "sumo" && hasAuthoredMapSignals ? "native" : provider;
}
