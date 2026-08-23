import type { CSSProperties } from "react";

interface AssetHoverTooltipProps {
  style: CSSProperties;
  hoverInfo: { count: number; name?: string };
}

/** Hover tooltip shown when the cursor is over an asset cluster or single asset pin. */
export function AssetHoverTooltip({ style, hoverInfo }: AssetHoverTooltipProps) {
  return (
    <div role="tooltip" style={style}>
      {hoverInfo.name ? (
        <>
          {hoverInfo.name} - <span style={{ opacity: 0.7 }}>click to select</span>
        </>
      ) : (
        <>
          {hoverInfo.count} assets here - <span style={{ opacity: 0.7 }}>click to select</span>
        </>
      )}
    </div>
  );
}
