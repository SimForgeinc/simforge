"use client";

import { Ruler } from "lucide-react";
import { C } from "./map-layer-constants";

type MeasureToolButtonProps = {
  active: boolean;
  onToggle: () => void;
};

/**
 * Toggle for the two-point distance-measure mode, pinned to the bottom-right
 * corner just above MapLibre's attribution control.
 */
export default function MeasureToolButton({ active, onToggle }: MeasureToolButtonProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={active}
      aria-label="Measure distance"
      title={active ? "Exit measure mode (Esc)" : "Measure distance"}
      style={{
        position: "absolute",
        bottom: "2.5rem",
        right: "0.75rem",
        zIndex: 10,
        width: "2rem",
        height: "2rem",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: "999px",
        border: `1px solid ${C.border}`,
        background: active ? C.fg : `${C.bg}f2`,
        color: active ? C.bg : C.fg,
        cursor: "pointer",
        boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
        transition: "background 0.15s, color 0.15s",
      }}
    >
      <Ruler size={15} aria-hidden />
    </button>
  );
}
