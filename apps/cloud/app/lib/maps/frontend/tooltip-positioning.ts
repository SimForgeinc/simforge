/**
 * Pure utility for computing tooltip/popover positions within a container,
 * clamped to stay within bounds. Used by MapAssetsMap for hover tooltips
 * and cluster selection popovers.
 */

export interface TooltipPositionConfig {
  /** Mouse/anchor position (x, y) in container coordinates. */
  position: { x: number; y: number };
  /** Container dimensions (width, height). */
  container: { width: number; height: number };
  /** Estimated tooltip dimensions for clamping. */
  tooltip: { width: number; height: number };
  /** Offset from the anchor position. Default: 10. */
  offset?: number;
  /** Minimum padding from container edges. Default: 8. */
  padding?: number;
}

/**
 * Compute clamped (left, top) position for a tooltip/popover so it stays
 * within the container bounds. Pure function, no DOM access.
 */
export function computeTooltipPosition(config: TooltipPositionConfig): { left: number; top: number } {
  const offset = config.offset ?? 10;
  const padding = config.padding ?? 8;

  const left = Math.max(
    padding,
    Math.min(config.position.x + offset, config.container.width - config.tooltip.width - padding),
  );
  const top = Math.max(
    padding,
    Math.min(config.position.y + offset, config.container.height - config.tooltip.height - padding),
  );

  return { left, top };
}
