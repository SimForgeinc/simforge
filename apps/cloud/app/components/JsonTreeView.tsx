"use client";

import { useState, useMemo } from "react";
import { ChevronRight, Eye, LocateFixed } from "lucide-react";
import { cn } from "@/app/lib/utils";
import {
  UUID_RE,
  tryParseJson,
  childCount,
  collapsedPreview,
  isSimple,
} from "@/app/lib/json-tree-utils";

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------


interface PrimitiveValueProps {
  value: unknown;
  onHighlightId?: (id: string) => void;
  onSelectId?: (id: string) => void;
  knownIds?: Set<string>;
}

function PrimitiveValue({ value, onHighlightId, onSelectId, knownIds }: PrimitiveValueProps) {
  if (value === null || value === undefined) {
    return <span className="text-muted-foreground/50 italic">null</span>;
  }
  if (typeof value === "boolean") {
    return (
      <span
        className={cn(
          "inline-flex items-center rounded px-1.5 py-px text-[10px] font-medium",
          value
            ? "bg-green-500/10 text-green-500"
            : "bg-muted text-muted-foreground",
        )}
      >
        {String(value)}
      </span>
    );
  }
  if (typeof value === "number") {
    return <span className="font-mono text-foreground">{value}</span>;
  }
  const str = String(value);
  // UUID strings get monospace compact styling + optional action buttons
  if (UUID_RE.test(str)) {
    const isKnown = knownIds?.has(str);
    return (
      <span className="inline-flex items-center gap-1">
        <span className="font-mono text-foreground/80 break-all text-[10px]">{str}</span>
        {isKnown && onHighlightId && (
          <button
            type="button"
            onClick={() => onHighlightId(str)}
            title="Highlight on map"
            className="inline-flex size-4 items-center justify-center rounded text-muted-foreground/50 transition-colors hover:text-sky-400 hover:bg-sky-400/10"
          >
            <Eye className="size-3" />
          </button>
        )}
        {isKnown && onSelectId && (
          <button
            type="button"
            onClick={() => onSelectId(str)}
            title="Select on map"
            className="inline-flex size-4 items-center justify-center rounded text-muted-foreground/50 transition-colors hover:text-primary hover:bg-primary/10"
          >
            <LocateFixed className="size-3" />
          </button>
        )}
      </span>
    );
  }
  return <span className="text-foreground break-words">{str}</span>;
}

interface JsonNodeProps {
  label?: string;
  value: unknown;
  depth: number;
  defaultExpanded?: boolean;
  /** When true, array nodes start collapsed regardless of size. */
  collapseArrays?: boolean;
  onHighlightId?: (id: string) => void;
  onSelectId?: (id: string) => void;
  knownIds?: Set<string>;
}

function JsonNode({ label, value, depth, defaultExpanded = false, collapseArrays = false, onHighlightId, onSelectId, knownIds }: JsonNodeProps) {
  const parsed = useMemo(() => tryParseJson(value), [value]);
  const simple = isSimple(parsed);
  const isArray = Array.isArray(parsed);
  const count = childCount(parsed);

  // For labeled properties whose value is an array, flatten: the property label
  // acts as the collapsible header for the array items directly (no intermediate array node).
  const flattenArray = isArray && label != null;

  const [expanded, setExpanded] = useState(() => {
    if (simple) return false;
    // Single-element arrays auto-expand; multi-element arrays with collapseArrays collapse
    if (flattenArray) return count === 1;
    if (collapseArrays && isArray) return false;
    // Small objects (≤3 keys) auto-expand so nested IDs with action buttons are visible
    if (!isArray && count <= 3) return true;
    // Auto-expand top-level and small nodes
    if (defaultExpanded) return true;
    if (depth <= 1 && count <= 6) return true;
    return false;
  });

  // All hooks must be called before any early returns (React rules of hooks).
  const effectiveIsArray = flattenArray || isArray;
  const entries = useMemo(() => {
    if (simple || !expanded) return [];
    if (flattenArray) {
      return (parsed as unknown[]).map((v, i) => [String(i), v] as const);
    }
    return isArray
      ? (parsed as unknown[]).map((v, i) => [String(i), v] as const)
      : Object.entries(parsed as Record<string, unknown>);
  }, [simple, expanded, flattenArray, isArray, parsed]);

  const VISIBLE_LIMIT = 50;
  const [showAll, setShowAll] = useState(false);

  // Simple/primitive value — early return after all hooks
  if (simple) {
    return (
      <div className="flex items-baseline gap-2 py-0.5" style={{ paddingLeft: depth * 12 }}>
        {label && (
          <span className="shrink-0 text-muted-foreground text-xs">{label}</span>
        )}
        <PrimitiveValue value={parsed} onHighlightId={onHighlightId} onSelectId={onSelectId} knownIds={knownIds} />
      </div>
    );
  }
  const visibleEntries = showAll ? entries : entries.slice(0, VISIBLE_LIMIT);
  const hasMore = entries.length > VISIBLE_LIMIT && !showAll;

  return (
    <div>
      {/* Collapsible header */}
      <button
        type="button"
        onClick={() => setExpanded((o) => !o)}
        className="flex w-full items-baseline gap-1.5 py-0.5 text-xs hover:bg-muted/30 rounded transition-colors"
        style={{ paddingLeft: depth * 12 }}
      >
        <ChevronRight
          className={cn(
            "size-3 shrink-0 text-muted-foreground transition-transform duration-150 mt-0.5",
            expanded && "rotate-90",
          )}
        />
        {label && (
          <span className="shrink-0 text-muted-foreground">{label}</span>
        )}
        {!expanded && (
          <span className="text-muted-foreground/60 font-mono text-[10px] truncate">
            {collapsedPreview(parsed)}
          </span>
        )}
        {expanded && effectiveIsArray && (
          <span className="text-muted-foreground/60 font-mono text-[10px]">
            [{count}]
          </span>
        )}
      </button>

      {/* Children — only rendered when expanded */}
      {expanded && (
        <div>
          {flattenArray
            ? // Flattened array: render each item's properties inline at depth+1
              visibleEntries.map(([key, val], idx) => {
                const itemParsed = tryParseJson(val);
                // Small objects: render key-value pairs directly without a collapsible wrapper
                if (
                  typeof itemParsed === "object" &&
                  itemParsed !== null &&
                  !Array.isArray(itemParsed) &&
                  Object.keys(itemParsed).length <= 4
                ) {
                  return (
                    <div key={key}>
                      {idx > 0 && <div className="border-t border-border/30 my-0.5" style={{ marginLeft: (depth + 1) * 12 }} />}
                      {Object.entries(itemParsed as Record<string, unknown>).map(([k, v]) => (
                        <JsonNode key={k} label={k} value={v} depth={depth + 1} collapseArrays={collapseArrays} onHighlightId={onHighlightId} onSelectId={onSelectId} knownIds={knownIds} />
                      ))}
                    </div>
                  );
                }
                // Fallback: render as a regular node
                return <JsonNode key={key} value={val} depth={depth + 1} collapseArrays={collapseArrays} onHighlightId={onHighlightId} onSelectId={onSelectId} knownIds={knownIds} />;
              })
            : visibleEntries.map(([key, val]) => (
              <JsonNode
                key={key}
                label={effectiveIsArray ? undefined : key}
                value={val}
                depth={depth + 1}
                collapseArrays={collapseArrays}
                onHighlightId={onHighlightId}
                onSelectId={onSelectId}
                knownIds={knownIds}
              />
            ))}
          {hasMore && (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="py-0.5 text-[10px] text-primary hover:text-primary/80 transition-colors"
              style={{ paddingLeft: (depth + 1) * 12 }}
            >
              Show {entries.length - VISIBLE_LIMIT} more…
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface JsonTreeViewProps {
  /** The data to render. Can be a flat key-value object or deeply nested JSON. */
  data: Record<string, unknown>;
  /** Whether top-level nodes start expanded. Default: true. */
  defaultExpanded?: boolean;
  /** When true, array nodes start collapsed. Default: false. */
  collapseArrays?: boolean;
  /** Callback to highlight a feature by GUID on the map. */
  onHighlightId?: (id: string) => void;
  /** Callback to select a feature by GUID on the map. */
  onSelectId?: (id: string) => void;
  /** Set of known feature GUIDs — buttons only appear for IDs in this set. */
  knownIds?: Set<string>;
  className?: string;
}

/**
 * Collapsible JSON tree viewer styled to match the app's design system.
 * Parses stringified JSON values, renders primitives inline, and makes
 * objects/arrays expandable. Suitable for GeoJSON feature property inspection.
 */
export function JsonTreeView({ data, defaultExpanded = true, collapseArrays = false, onHighlightId, onSelectId, knownIds, className }: JsonTreeViewProps) {
  const entries = Object.entries(data);

  if (entries.length === 0) {
    return (
      <p className="text-xs text-muted-foreground/50 italic py-2">No properties</p>
    );
  }

  return (
    <div className={cn("text-xs", className)}>
      {entries.map(([key, value]) => (
        <JsonNode
          key={key}
          label={key}
          value={value}
          depth={0}
          defaultExpanded={defaultExpanded}
          collapseArrays={collapseArrays}
          onHighlightId={onHighlightId}
          onSelectId={onSelectId}
          knownIds={knownIds}
        />
      ))}
    </div>
  );
}
