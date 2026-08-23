"use client";

import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import { Download, ExternalLink, Loader2, Sparkles } from "lucide-react";
import { COLLISION_TEMPLATES } from "@simcloud/shared";
import type { CollisionFamilyId } from "@simcloud/shared";
import { cn } from "@/app/lib/utils";
import type { ScenarioValidationState } from "@/app/lib/maps/frontend/use-scenario-validation";
import type { LlmProposedScenarioRecord } from "@/app/lib/maps/frontend/use-map-search-llm";
import { ValidationVerdictCard } from "./ValidationVerdictCard";
import { useState } from "react";
import type { ComponentProps } from "react";

// Re-use the same markdown component overrides as the assistant bubble.
const ASSISTANT_MD_COMPONENTS: ComponentProps<typeof ReactMarkdown>["components"] = {
  pre({ children }) {
    return <>{children}</>;
  },
  code({ className, children, ...props }) {
    const isBlock = /language-/.test(className ?? "");
    return isBlock ? (
      <pre className="my-1.5 overflow-x-auto rounded-md bg-background/80 p-2.5 text-[11px]">
        <code className={cn("font-mono", className)} {...props}>
          {children}
        </code>
      </pre>
    ) : (
      <code className="rounded bg-background/80 px-1 py-0.5 font-mono text-[11px]" {...props}>
        {children}
      </code>
    );
  },
  p({ children }) {
    return <p className="mt-1 leading-relaxed first:mt-0">{children}</p>;
  },
  strong({ children }) {
    return <strong className="font-semibold text-foreground">{children}</strong>;
  },
};

/**
 * Resolve a collision family id to its human-readable label.
 */
export function formatCollisionFamilyLabel(family: string): string {
  const template = COLLISION_TEMPLATES[family as CollisionFamilyId];
  if (template) return template.label;
  return family.replace(/_/g, " ");
}

/**
 * Map a document's humanized subtype to a short noun for the synthesized
 * directive prompt. Falls back to "location".
 */
export function subtypeToFriendlyNoun(subtype: string): string {
  const lower = subtype.toLowerCase();
  if (lower.includes("crosswalk")) return "crosswalk";
  if (lower.includes("sidewalk")) return "sidewalk";
  if (lower.includes("junction") || lower.includes("intersection")) return "intersection";
  if (lower.includes("bus stop")) return "bus stop";
  if (lower.includes("transit")) return "transit stop";
  if (lower.includes("parking lot")) return "parking lot";
  if (lower.includes("parking cluster") || lower.includes("parking area")) return "parking area";
  if (lower.includes("street parking")) return "street-parking strip";
  if (lower.includes("school")) return "school zone";
  if (lower.includes("hospital")) return "hospital approach";
  if (lower.includes("retail")) return "storefront";
  if (lower.includes("restaurant")) return "restaurant";
  if (lower.includes("hotel")) return "hotel";
  if (lower.includes("airport")) return "airport drop-off";
  if (lower.includes("mall")) return "shopping center";
  if (lower.includes("gas station")) return "gas station";
  if (lower.includes("occlusion")) return "occlusion zone";
  if (lower.includes("collision")) return "collision site";
  if (lower.includes("street") || lower.includes("road")) return "road segment";
  if (lower.includes("address")) return "address";
  return "location";
}

export function ProposedScenariosBlock({
  messageId,
  drafts,
  showDebug,
  selectedScenarioId,
  onSelectScenario,
  validation,
}: {
  messageId: string;
  drafts: LlmProposedScenarioRecord[];
  showDebug: boolean;
  selectedScenarioId: string | null;
  onSelectScenario?: (scenarioId: string) => void;
  validation?: ScenarioValidationState | null;
}) {
  return (
    <div className="space-y-1.5 rounded-md border border-primary/30 bg-primary/5 p-2">
      <p className="flex items-center gap-1.5 text-[11px] font-semibold text-foreground">
        <Sparkles className="size-3 text-primary" aria-hidden="true" />
        {drafts.length === 1 ? "Draft created" : `${drafts.length} drafts created`}
      </p>
      <div className="space-y-1.5">
        {drafts.map((draft) => {
          const failed = draft.validation?.verdict === "fail";
          const selected = selectedScenarioId === draft.scenarioId;
          const handleCardClick = onSelectScenario
            ? () => onSelectScenario(draft.scenarioId)
            : undefined;
          const stopBubble = (event: React.MouseEvent) => {
            event.stopPropagation();
          };
          return (
          <div
            key={`${messageId}-draft-${draft.scenarioId}`}
            onClick={handleCardClick}
            onKeyDown={(event) => {
              if (!handleCardClick) return;
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                handleCardClick();
              }
            }}
            role={handleCardClick ? "button" : undefined}
            tabIndex={handleCardClick ? 0 : undefined}
            aria-pressed={handleCardClick ? selected : undefined}
            aria-label={
              handleCardClick
                ? selected
                  ? `Hide ${draft.displayName} from the map`
                  : `Show ${draft.displayName} on the map`
                : undefined
            }
            className={cn(
              "space-y-1.5 rounded-sm border px-2 py-1.5 text-[11px] transition-colors",
              handleCardClick && "cursor-pointer",
              failed
                ? "border-destructive/50 bg-destructive/5"
                : "border-border/60 bg-background/60",
              selected && "ring-2 ring-primary/70 ring-offset-1 ring-offset-background",
            )}
          >
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <div className="block font-medium text-foreground">
                  {failed ? (
                    <span className="mr-1 rounded bg-destructive/15 px-1 py-px align-middle text-[9px] font-semibold uppercase tracking-wide text-destructive">
                      Failed
                    </span>
                  ) : null}
                  {draft.displayName}
                </div>
                {draft.family || draft.actorCount != null ? (
                  <div className="block text-[10px] text-muted-foreground">
                    {[
                      draft.family ? formatCollisionFamilyLabel(draft.family) : null,
                      draft.actorCount != null
                        ? `${draft.actorCount} actor${draft.actorCount === 1 ? "" : "s"}`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" • ")}
                  </div>
                ) : null}
                {failed && draft.validation?.reason ? (
                  <div className="mt-0.5 block text-[10px] text-destructive">
                    {draft.validation.reason}
                  </div>
                ) : null}
              </div>
              {failed ? (
                <a
                  href={draft.editorHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={stopBubble}
                  className="inline-flex shrink-0 items-center gap-1 text-muted-foreground transition-colors hover:text-foreground"
                  aria-label={`Open the FAILED draft "${draft.displayName}" in the editor anyway (new tab)`}
                  title="This draft failed validation — opening it lets you inspect or fix it manually"
                >
                  Open anyway
                  <ExternalLink className="size-3" aria-hidden="true" />
                </a>
              ) : (
                <a
                  href={draft.editorHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={stopBubble}
                  className="inline-flex shrink-0 items-center gap-1 text-primary transition-colors hover:opacity-80"
                  aria-label={`Open scenario "${draft.displayName}" in the editor (new tab)`}
                >
                  Open in editor
                  <ExternalLink className="size-3" aria-hidden="true" />
                </a>
              )}
              {showDebug ? (
                <div onClick={stopBubble}>
                  <DownloadDraftJsonButton
                    scenarioId={draft.scenarioId}
                    displayName={draft.displayName}
                  />
                </div>
              ) : null}
            </div>
            {draft.description ? (
              <div className="text-[10.5px] leading-snug text-muted-foreground [&_p]:my-0.5 [&_ul]:my-0.5 [&_ul]:list-disc [&_ul]:pl-4 [&_strong]:text-foreground">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  rehypePlugins={[rehypeSanitize]}
                  components={ASSISTANT_MD_COMPONENTS}
                >
                  {draft.description}
                </ReactMarkdown>
              </div>
            ) : null}
            {selected && validation ? (
              <div onClick={stopBubble}>
                <ValidationVerdictCard validation={validation} />
              </div>
            ) : null}
          </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Fetches the persisted scenario draft JSON and triggers a browser save.
 * Visible only in debug mode.
 */
export function DownloadDraftJsonButton({
  scenarioId,
  displayName,
}: {
  scenarioId: string;
  displayName: string;
}) {
  const [busy, setBusy] = useState(false);

  function safeFilename(name: string): string {
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60);
    return `${slug || "scenario"}-${scenarioId.slice(0, 8)}.json`;
  }

  async function handleDownload() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(
        `/api/scenarios/${encodeURIComponent(scenarioId)}/draft`,
      );
      if (!res.ok) {
        console.warn(
          `[ai-search] draft download failed (${res.status}) for scenario ${scenarioId}`,
        );
        return;
      }
      const draft = await res.json();
      let validation: unknown = null;
      try {
        const vres = await fetch(
          `/api/scenarios/${encodeURIComponent(scenarioId)}/validate/status`,
        );
        if (vres.ok) {
          validation = await vres.json();
        }
      } catch (vErr) {
        console.warn(
          `[ai-search] validation status fetch failed for scenario ${scenarioId}:`,
          vErr,
        );
      }
      const payload =
        validation && draft && typeof draft === "object" && !Array.isArray(draft)
          ? { ...draft, _validation: validation }
          : draft;
      const blob = new Blob([JSON.stringify(payload, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = safeFilename(displayName);
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.warn(
        `[ai-search] draft download error for scenario ${scenarioId}:`,
        err,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handleDownload}
      disabled={busy}
      aria-label={`Download "${displayName}" draft as JSON`}
      title="Download draft JSON"
      className={cn(
        "inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors",
        "hover:bg-muted/40 hover:text-foreground",
        "disabled:opacity-40 disabled:pointer-events-none",
      )}
    >
      {busy ? (
        <Loader2 className="size-3 animate-spin" aria-hidden="true" />
      ) : (
        <Download className="size-3" aria-hidden="true" />
      )}
    </button>
  );
}
