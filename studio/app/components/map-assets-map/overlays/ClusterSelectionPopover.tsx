import type { CSSProperties } from "react";
import type { MapAsset } from "@simforge-oss/studio-shared";
import { C } from "../map-layer-constants";

interface ClusterSelectionPopoverProps {
  style: CSSProperties;
  assets: MapAsset[];
  onSelectAsset: (id: string) => void;
  onClose: () => void;
}

/** Popover shown when a cluster of overlapping assets is clicked, listing each asset for selection. */
export function ClusterSelectionPopover({
  style,
  assets,
  onSelectAsset,
  onClose,
}: ClusterSelectionPopoverProps) {
  return (
    <div
      role="dialog"
      aria-label="Select map asset"
      style={style}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div style={{ marginBottom: "0.5rem", color: C.muted, fontWeight: 500 }}>
        {assets.length} maps at this location
      </div>
      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {assets.map((asset) => (
          <li key={asset.map_asset_id} style={{ marginBottom: "0.25rem" }}>
            <button
              type="button"
              onClick={() => onSelectAsset(asset.map_asset_id)}
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                padding: "0.5rem 0.6rem",
                background: "rgba(255,255,255,0.05)",
                border: `1px solid ${C.border}`,
                borderRadius: "6px",
                color: C.fg,
                fontSize: "0.8125rem",
                fontFamily: C.font,
                cursor: "pointer",
              }}
            >
              {asset.name}
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={onClose}
        style={{
          marginTop: "0.5rem",
          padding: "0.25rem 0.5rem",
          fontSize: "0.75rem",
          fontFamily: C.font,
          color: C.muted,
          background: "transparent",
          border: "none",
          cursor: "pointer",
        }}
      >
        Close
      </button>
    </div>
  );
}
