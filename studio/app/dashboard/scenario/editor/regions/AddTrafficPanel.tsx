"use client";

import { Ban, Building2, Car, Gauge, Network, Truck } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import {
  AMBIENT_TRAFFIC_EXTENSION_KEY,
  AMBIENT_TRAFFIC_PROVIDER_EXTENSION_KEY,
  ambientTrafficProfileFromExtensions,
  ambientTrafficProviderFromExtensions,
  profileForPreset,
  type AmbientTrafficProviderId,
  type SumoTrafficStatus,
} from "@simforge-oss/playback/traffic";
import type { EditorDocument } from "@simforge-oss/editor";

import {
  matchesSearch,
  PanelSection,
  PanelTile,
  PanelTileGrid,
  type SceneSearchResult,
} from "./panel-tiles";

type TrafficPreset = "off" | "light" | "moderate" | "heavy" | "city";

const SOURCE_CHOICES: readonly {
  value: AmbientTrafficProviderId;
  label: string;
  detail: string;
  icon: typeof Car;
}[] = [
  { value: "off", label: "None", detail: "Authored actors only", icon: Ban },
  { value: "native", label: "City sim", detail: "Deterministic fill", icon: Building2 },
  { value: "sumo", label: "SUMO", detail: "Microsimulation", icon: Network },
];

const DENSITY_CHOICES: readonly {
  value: TrafficPreset;
  label: string;
  icon: typeof Car;
}[] = [
  { value: "off", label: "Empty", icon: Ban },
  { value: "light", label: "Light", icon: Car },
  { value: "moderate", label: "Moderate", icon: Gauge },
  { value: "heavy", label: "Heavy", icon: Truck },
  { value: "city", label: "City", icon: Building2 },
];

/**
 * Traffic as a gallery, in the add-actor panel.
 *
 * The two decisions that change what an author sees — who drives the background
 * road users, and how many of them there are — are tiles, picked the same way a
 * car is picked. `details` carries the existing numeric editor for the author
 * who wants to tune flows, mix and seed; it is deliberately below the fold.
 */
export function AddTrafficPanel({
  details,
  document,
  sumoAvailable = true,
  sumoStatus = null,
}: {
  details?: ReactNode;
  document: EditorDocument | null;
  sumoAvailable?: boolean;
  sumoStatus?: SumoTrafficStatus | null;
}) {
  if (!document) {
    return (
      <p style={styles.unavailable} data-testid="add-traffic-unavailable">
        Traffic becomes editable once the scenario finishes loading.
      </p>
    );
  }

  const extensions = document.data.extensions;
  const provider = ambientTrafficProviderFromExtensions(extensions);
  const profile = ambientTrafficProfileFromExtensions(extensions);
  const phase = sumoStatus?.phase === "disabled" ? "off" : sumoStatus?.phase ?? "off";

  return (
    <div data-testid="add-traffic-panel">
      <PanelSection label="Traffic source" testId="traffic-section-source">
        <PanelTileGrid>
          {SOURCE_CHOICES.map((choice, index) => {
            const Icon = choice.icon;
            const blocked = choice.value === "sumo" && !sumoAvailable;
            return (
              <PanelTile
                active={provider === choice.value}
                detail={choice.value === "sumo" && provider === "sumo" ? phase : choice.detail}
                disabled={blocked}
                icon={<Icon aria-hidden="true" size={22} strokeWidth={1.6} />}
                index={index}
                key={choice.value}
                label={choice.label}
                onChoose={() => document.setAmbientTrafficExtension(
                  AMBIENT_TRAFFIC_PROVIDER_EXTENSION_KEY,
                  choice.value,
                )}
                testId={`traffic-source-${choice.value}`}
                title={blocked
                  ? "SUMO is unavailable because this map has no immutable SUMO network."
                  : choice.detail}
              />
            );
          })}
        </PanelTileGrid>
      </PanelSection>

      <PanelSection label="How much traffic" testId="traffic-section-density">
        <PanelTileGrid>
          {DENSITY_CHOICES.map((choice, index) => {
            const Icon = choice.icon;
            const preview = profileForPreset(choice.value);
            return (
              <PanelTile
                active={profile.preset === choice.value}
                detail={choice.value === "off"
                  ? "No background cars"
                  : `${preview.densityVehiclesPerKm} veh/km`}
                icon={<Icon aria-hidden="true" size={22} strokeWidth={1.6} />}
                index={index}
                key={choice.value}
                label={choice.label}
                onChoose={() => document.setAmbientTrafficExtension(
                  AMBIENT_TRAFFIC_EXTENSION_KEY,
                  profileForPreset(choice.value, profile),
                )}
                testId={`traffic-density-${choice.value}`}
              />
            );
          })}
        </PanelTileGrid>
      </PanelSection>

      {profile.preset === "custom" ? (
        <p style={styles.note} data-testid="add-traffic-custom-note">
          This scenario uses hand-tuned traffic numbers. Picking a tile above
          replaces them.
        </p>
      ) : null}

      {details ? (
        <PanelSection label="Fine tuning" testId="traffic-section-details">
          <div style={styles.details}>{details}</div>
        </PanelSection>
      ) : null}
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  unavailable: { padding: "10px 0", color: "#8d97a5", fontSize: 10, lineHeight: 1.5 },
  note: { margin: "0 0 14px", padding: "7px 9px", borderLeft: "2px solid rgba(232,224,68,.5)", color: "#9aa2ad", fontSize: 9, lineHeight: 1.4 },
  details: { paddingTop: 2 },
};

/** Traffic hits for the universal search. */
export function trafficSearchResults(
  query: string,
  document: EditorDocument | null,
): SceneSearchResult[] {
  if (!document) return [];
  const extensions = document.data.extensions;
  const provider = ambientTrafficProviderFromExtensions(extensions);
  const profile = ambientTrafficProfileFromExtensions(extensions);
  const results: SceneSearchResult[] = [];
  for (const choice of SOURCE_CHOICES) {
    if (!matchesSearch(query, choice.label, choice.detail, "traffic source", choice.value)) continue;
    const Icon = choice.icon;
    results.push({
      id: `traffic.source.${choice.value}`,
      label: `${choice.label} traffic`,
      detail: choice.detail,
      group: "Traffic",
      icon: <Icon aria-hidden="true" size={22} strokeWidth={1.6} />,
      active: provider === choice.value,
      apply: () => document.setAmbientTrafficExtension(
        AMBIENT_TRAFFIC_PROVIDER_EXTENSION_KEY,
        choice.value,
      ),
    });
  }
  for (const choice of DENSITY_CHOICES) {
    if (!matchesSearch(query, choice.label, "traffic density", choice.value)) continue;
    const Icon = choice.icon;
    results.push({
      id: `traffic.density.${choice.value}`,
      label: `${choice.label} traffic`,
      detail: choice.value === "off"
        ? "No background cars"
        : `${profileForPreset(choice.value).densityVehiclesPerKm} veh/km`,
      group: "Traffic",
      icon: <Icon aria-hidden="true" size={22} strokeWidth={1.6} />,
      active: profile.preset === choice.value,
      apply: () => document.setAmbientTrafficExtension(
        AMBIENT_TRAFFIC_EXTENSION_KEY,
        profileForPreset(choice.value, profile),
      ),
    });
  }
  return results;
}

