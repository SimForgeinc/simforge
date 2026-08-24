"use client";

import type {
  AmbientTrafficProvenance,
  ResolvedAmbientTrafficProfile,
} from "@simforge/engine";
import { AmbientTrafficPanel } from "@/app/lib/scenario/ambient/AmbientTrafficPanel";
import {
  ACCELERATED_SIGNAL_CYCLES_EXTENSION_KEY,
  ALL_SUMO_SIGNALS_GREEN_EXTENSION_KEY,
  AMBIENT_TRAFFIC_EXTENSION_KEY,
  allSumoSignalsGreenFromExtensions,
  ambientSignalCycleSettingsFromExtensions,
  ambientTrafficProfileFromExtensions,
} from "@simforge/playback/traffic";
import {
  AMBIENT_TRAFFIC_PROVIDER_EXTENSION_KEY,
  ambientTrafficProviderFromExtensions,
  type AmbientTrafficProviderId,
  type SumoTrafficStatus,
} from "@simforge/playback/traffic";
import type { EditorDocument } from "@simforge/editor";

/**
 * Editor adapter for Scenario's canonical ambient traffic controls.
 *
 * Provider, demand profile, and signal-cycle policy intentionally remain three
 * independent execution-bearing extensions. Keeping that split here means the
 * editor, browser preview, compiler, and render workers all consume the exact
 * same configuration without a second SUMO-specific state model.
 */
export function AmbientEditor({
  document,
  sumoStatus = null,
  provenance = null,
  sumoAvailable,
}: {
  document: EditorDocument;
  sumoStatus?: SumoTrafficStatus | null;
  provenance?: AmbientTrafficProvenance | null;
  sumoAvailable: boolean;
}) {
  const extensions = document.data.extensions;
  const provider = ambientTrafficProviderFromExtensions(extensions);
  const profile = ambientTrafficProfileFromExtensions(extensions);
  const acceleratedSignalCycles = ambientSignalCycleSettingsFromExtensions(
    extensions,
  ).acceleratedSignalCycles;
  const allSignalsGreen = allSumoSignalsGreenFromExtensions(extensions);

  const updateProfile = (next: ResolvedAmbientTrafficProfile) =>
    document.setAmbientTrafficExtension(AMBIENT_TRAFFIC_EXTENSION_KEY, next);
  const updateProvider = (next: AmbientTrafficProviderId) =>
    document.setAmbientTrafficExtension(
      AMBIENT_TRAFFIC_PROVIDER_EXTENSION_KEY,
      next,
    );

  return (
    <section data-testid="ambient-editor">
      <AmbientTrafficPanel
        alwaysOpen
        profile={profile}
        provenance={provenance}
        provider={provider}
        onProviderChange={updateProvider}
        onChange={updateProfile}
        acceleratedSignalCycles={acceleratedSignalCycles}
        onAcceleratedSignalCyclesChange={(enabled) =>
          document.setAmbientTrafficExtension(
            ACCELERATED_SIGNAL_CYCLES_EXTENSION_KEY,
            enabled ? true : undefined,
          )
        }
        allSignalsGreen={allSignalsGreen}
        onAllSignalsGreenChange={(enabled) =>
          document.setAmbientTrafficExtension(
            ALL_SUMO_SIGNALS_GREEN_EXTENSION_KEY,
            enabled ? true : undefined,
          )
        }
        sumoStatus={sumoStatus}
        sumoAvailable={sumoAvailable}
        sumoUnavailableReason="SUMO is unavailable because this map has no immutable SUMO network."
      />
    </section>
  );
}
