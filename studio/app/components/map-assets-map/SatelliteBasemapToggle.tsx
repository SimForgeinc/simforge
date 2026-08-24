"use client";

import { C } from "./map-layer-constants";

type SatelliteBasemapToggleProps = {
  satelliteEnabled: boolean;
  onChange: (enabled: boolean) => void;
};

/**
 * Map / Satellite basemap switch, shown only when the viewed map asset has a
 * SimScene imagery tileset configured.
 */
export default function SatelliteBasemapToggle({
  satelliteEnabled,
  onChange,
}: SatelliteBasemapToggleProps) {
  const options = [
    { label: "Map", satellite: false },
    { label: "Satellite", satellite: true },
  ];
  return (
    <div
      style={{
        position: "absolute",
        bottom: "0.75rem",
        left: "0.75rem",
        zIndex: 10,
        display: "flex",
        borderRadius: "999px",
        overflow: "hidden",
        border: `1px solid ${C.border}`,
        boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
        fontFamily: C.font,
      }}
    >
      {options.map((option) => {
        const isActive = option.satellite === satelliteEnabled;
        return (
          <button
            key={option.label}
            type="button"
            onClick={() => onChange(option.satellite)}
            aria-pressed={isActive}
            style={{
              padding: "0.3rem 0.75rem",
              fontSize: "0.75rem",
              fontWeight: isActive ? 600 : 400,
              cursor: isActive ? "default" : "pointer",
              border: "none",
              background: isActive ? C.fg : `${C.bg}f2`,
              color: isActive ? C.bg : C.fg,
              transition: "background 0.15s, color 0.15s",
              whiteSpace: "nowrap",
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
