import type { CSSProperties } from "react";
import { C } from "../map-layer-constants";

interface FeatureHoverTooltipProps {
  style: CSSProperties;
  items: { id: number; summary: string }[];
}

/** Hover tooltip shown when the cursor is over GeoJSON/enrichment/signal features. */
export function FeatureHoverTooltip({ style, items }: FeatureHoverTooltipProps) {
  const uniqueItems = items.filter(
    (item, index, allItems) =>
      allItems.findIndex((candidate) => candidate.summary === item.summary) ===
      index,
  );
  const [primaryItem, ...secondaryItems] = uniqueItems;

  return (
    <div role="tooltip" data-testid="feature-hover-tooltip" style={style}>
      {primaryItem ? (
        <div style={{ fontSize: "0.75rem", fontWeight: 600, lineHeight: 1.35 }}>
          {primaryItem.summary}
        </div>
      ) : null}
      {secondaryItems.length > 0 ? (
        <ul
          style={{
            listStyle: "none",
            margin: "0.35rem 0 0",
            padding: 0,
            display: "flex",
            flexDirection: "column",
            gap: "0.2rem",
          }}
        >
          {secondaryItems.map((item) => (
            <li
              key={item.id}
              style={{
                color: C.muted,
                fontSize: "0.72rem",
                lineHeight: 1.3,
              }}
            >
              {item.summary}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
