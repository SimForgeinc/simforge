import { useCallback, useEffect, useState } from "react";
import type { MeasurePoint } from "@/app/lib/maps/frontend/measure-distance";

/**
 * Two-point distance-measure mode for the map-assets map. While active the
 * tool owns every map click: the first click drops the start point, the
 * second pins the measurement, and a third starts a fresh measurement at
 * that spot. Esc — or toggling the ruler button — exits and clears.
 */
export function useMeasureTool(enabled: boolean) {
  const [active, setActive] = useState(false);
  /** Placed endpoints, oldest first; never more than two. */
  const [points, setPoints] = useState<MeasurePoint[]>([]);
  /** Live cursor position, tracked only while rubber-banding. */
  const [cursor, setCursor] = useState<MeasurePoint | null>(null);

  const exit = useCallback(() => {
    setActive(false);
    setPoints([]);
    setCursor(null);
  }, []);

  const toggle = useCallback(() => {
    setPoints([]);
    setCursor(null);
    setActive((prev) => !prev);
  }, []);

  const clear = useCallback(() => {
    setPoints([]);
    setCursor(null);
  }, []);

  // Leaving the surface that offers the tool retires the mode outright.
  useEffect(() => {
    if (!enabled) exit();
  }, [enabled, exit]);

  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") exit();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, exit]);

  /** Returns true when the click was consumed by the tool. */
  const handleMapClick = useCallback(
    (point: MeasurePoint): boolean => {
      if (!active) return false;
      setCursor(null);
      setPoints((prev) => (prev.length >= 2 ? [point] : [...prev, point]));
      return true;
    },
    [active],
  );

  const rubberBandActive = active && points.length === 1;
  const handlePointerMove = useCallback(
    (point: MeasurePoint) => {
      if (rubberBandActive) setCursor(point);
    },
    [rubberBandActive],
  );

  const handlePointerLeave = useCallback(() => {
    setCursor(null);
  }, []);

  return {
    active,
    points,
    cursor,
    toggle,
    clear,
    handleMapClick,
    handlePointerMove,
    handlePointerLeave,
  };
}
