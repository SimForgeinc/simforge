"use client";

import { useState } from "react";
import type { MutableRefObject } from "react";
import {
  CopyPlus,
  Download,
  GitBranch,
  MoreHorizontal,
  Pencil,
  Trash2,
  Video,
} from "lucide-react";
import { CloudActivityIndicator } from "@/app/components/CloudLoadingSurface";
import type {
  UniScenarioDocumentSummaryDto,
  UniScenarioRatingAggregateDto,
  UniScenarioTagDto,
} from "@/app/lib/uniscenario/contracts";
import { Button } from "@/app/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/app/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/app/components/ui/dropdown-menu";
import { cn } from "@/app/lib/utils";
import { documentCardTransitionName } from "./datasetMorph";
import {
  documentEditedAtLabel,
  documentLastEditorName,
  documentMapLabel,
  documentName,
} from "./document-list-utils";
import { UniScenarioRating } from "./UniScenarioRating";
import { useUniScenarioOpenScenarioExport } from "./useUniScenarioOpenScenarioExport";

export const UNISCENARIO_TAG_DRAG_MIME = "application/x-simforge-uniscenario-tag-id";

/**
 * Whether the row shows its variations (fork) toggle.
 *
 * A named constant rather than deleted markup: the decision to drop cross-map variations is a product
 * call that could be revisited, and a flag records that this was switched off deliberately instead of
 * leaving a future reader to wonder whether the button was ever wired.
 */
const SHOW_VARIATIONS_TOGGLE = false;

type RenderState = "missing" | "complete" | "running";

function renderIconClassName(state: RenderState) {
  // Traffic-light semantics, and deliberately not tokens: `primary` is the brand yellow, so a
  // running render would be indistinguishable from every other accent in the row.
  if (state === "running") return "text-yellow-400 hover:text-yellow-300";
  if (state === "complete") return "text-green-400 hover:text-green-300";
  return "text-red-400 hover:text-red-300";
}

function renderIconTitle(
  state: RenderState,
  hasSensorProfile: boolean,
) {
  if (!hasSensorProfile) return "Add a sensor profile to an actor before rendering";
  if (state === "running") return "Render running";
  if (state === "complete") return "Rendered";
  return "No render";
}

/**
 * An operator-chosen tag colour as a chip style.
 *
 * Inline rather than a class because the value is data. `color-mix` keeps the border and fill derived
 * from the one colour, so a tag stays one visual object at any hue — v1 hand-rolled the same thing
 * with a hex→rgba helper.
 */
function tagChipStyle(color: string | null) {
  const base = color ?? "var(--accent-brand)";
  return {
    borderColor: `color-mix(in srgb, ${base} 38%, transparent)`,
    backgroundColor: `color-mix(in srgb, ${base} 10%, transparent)`,
    color: base,
  };
}

export type UniScenarioDocumentRowProps = {
  document: UniScenarioDocumentSummaryDto;
  datasetId: string;
  active: boolean;
  advancedMode: boolean;
  tagEditorMode: boolean;
  mutable: boolean;
  busy: boolean;
  renaming: boolean;
  renameDraft: string;
  renderActive?: boolean;
  /**
   * Another scenario owns the render pane. Recedes this row so the one being rendered reads as the
   * subject of the pane beside it.
   */
  renderDimmed?: boolean;
  renderInProgress: boolean;
  /** Variation sub-rows are the same scenario on another map, so they are titled by map. */
  labelByMap?: boolean;
  variationCount?: number;
  variationsExpanded?: boolean;
  availableTags: UniScenarioTagDto[];
  ratingAggregate?: UniScenarioRatingAggregateDto;
  ratingLoading?: boolean;
  ratingSaving?: boolean;
  ratingError?: string | null;
  draggingTagId: string | null;
  draggingTagIdRef: MutableRefObject<string | null>;
  onClearDraggingTag: () => void;
  onAssignTag: (documentId: string, tagId: string) => void;
  onRenameDraftChange: (next: string) => void;
  onSetRenamingDocumentId: (id: string | null) => void;
  onCommitRename: (document: UniScenarioDocumentSummaryDto, draft: string) => void;
  onOpenDocument: (document: UniScenarioDocumentSummaryDto) => void;
  onEditDocument: (document: UniScenarioDocumentSummaryDto) => void;
  /**
   * Whether this document is the one currently open in the editor.
   *
   * Mirrors v1's row: the pencil is a toggle, not a one-way trip. Without it the button gives no sign
   * that this row is the open one, and there is no way back to the list from the row that opened it.
   */
  editActive?: boolean;
  /** Close the editor and return to the list. Required for the toggle half of `editActive`. */
  onExitEdit?: () => void;
  onRenderDocument: (document: UniScenarioDocumentSummaryDto) => void;
  onDownloadDocument: (document: UniScenarioDocumentSummaryDto) => void;
  onDuplicateDocument: (document: UniScenarioDocumentSummaryDto) => void;
  onEditDetails: (document: UniScenarioDocumentSummaryDto) => void;
  onDeleteDocument: (document: UniScenarioDocumentSummaryDto) => void;
  onSetRating: (rating: number) => void;
  onToggleVariations?: (document: UniScenarioDocumentSummaryDto) => void;
  onError: (error: unknown, fallback: string) => void;
  onNotice?: (message: string | null) => void;
};

function DocumentActionCluster({
  document,
  datasetId: _datasetId,
  mutable,
  busy,
  renaming,
  renameDraft,
  editActive = false,
  renderActive = false,
  renderInProgress,
  variationCount = 0,
  variationsExpanded = false,
  onRenameDraftChange,
  onSetRenamingDocumentId,
  onCommitRename,
  onEditDocument,
  onExitEdit,
  onRenderDocument,
  onDownloadDocument,
  onDuplicateDocument,
  onEditDetails,
  onDeleteDocument,
  onToggleVariations,
  onError,
  onNotice,
}: Pick<
  UniScenarioDocumentRowProps,
  | "document"
  | "datasetId"
  | "mutable"
  | "busy"
  | "renaming"
  | "renameDraft"
  | "editActive"
  | "renderActive"
  | "renderInProgress"
  | "variationCount"
  | "variationsExpanded"
  | "onRenameDraftChange"
  | "onSetRenamingDocumentId"
  | "onCommitRename"
  | "onEditDocument"
  | "onExitEdit"
  | "onRenderDocument"
  | "onDownloadDocument"
  | "onDuplicateDocument"
  | "onEditDetails"
  | "onDeleteDocument"
  | "onToggleVariations"
  | "onError"
  | "onNotice"
>) {
  const label = documentName(document);
  const openScenarioExport = useUniScenarioOpenScenarioExport({
    documentId: document.id,
    onError,
    onNotice,
  });
  const renderState: RenderState = renderInProgress
    ? "running"
    : document.hasRender
      ? "complete"
      : "missing";
  const anyBusy = busy || openScenarioExport.busy;
  const renderDisabled = !document.hasSensorProfile;

  return (
    <div className="flex shrink-0 items-center justify-end gap-1">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-7 text-foreground/65 hover:text-foreground"
            disabled={anyBusy}
            aria-label={`Scenario actions for ${label}`}
          >
            {anyBusy ? (
              <CloudActivityIndicator iconClassName="size-3.5" />
            ) : (
              <MoreHorizontal className="size-3.5" aria-hidden="true" />
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[160px]">
          <DropdownMenuItem onSelect={() => onDownloadDocument(document)}>
            <Download className="mr-2 size-3.5" aria-hidden="true" />
            Download JSON
          </DropdownMenuItem>
          {openScenarioExport.menuItem}
          <DropdownMenuItem disabled={!mutable} onSelect={() => onEditDetails(document)}>
            <Pencil className="mr-2 size-3.5" aria-hidden="true" />
            Edit details
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onDuplicateDocument(document)}>
            <CopyPlus className="mr-2 size-3.5" aria-hidden="true" />
            Duplicate
          </DropdownMenuItem>
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            disabled={!mutable}
            onSelect={() => onDeleteDocument(document)}
          >
            <Trash2 className="mr-2 size-3.5" aria-hidden="true" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {renaming ? (
        <input
          autoFocus
          type="text"
          aria-label={`Rename ${label}`}
          value={renameDraft}
          onChange={(event) => onRenameDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              const draft = renameDraft;
              onSetRenamingDocumentId(null);
              onCommitRename(document, draft);
            } else if (event.key === "Escape") {
              event.preventDefault();
              onSetRenamingDocumentId(null);
            }
          }}
          onBlur={() => {
            const draft = renameDraft;
            onSetRenamingDocumentId(null);
            onCommitRename(document, draft);
          }}
          className="h-7 w-28 border border-primary/40 bg-background px-1.5 text-xs font-medium text-foreground outline-none focus:border-primary"
        />
      ) : null}
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className={cn(
          "size-7 bg-transparent hover:bg-transparent hover:text-foreground",
          editActive ? "text-primary" : "text-foreground/65",
        )}
        aria-label={editActive ? `Exit editor for ${label}` : `Edit ${label}`}
        aria-pressed={editActive}
        title={editActive ? "Exit editor" : "Edit"}
        onClick={() => {
          // Only a toggle when a way back was supplied; otherwise pressing it again would appear to do
          // nothing at all.
          if (editActive && onExitEdit) {
            onExitEdit();
            return;
          }
          onEditDocument(document);
        }}
      >
        <Pencil className="size-3.5" aria-hidden="true" />
      </Button>
      {/* The fork/variations affordance is hidden by decision (2026-08-04): cross-map variations is
          dropped along with the archive export-package and the old play preview, and preview is being
          rebuilt on the ported studio playback runtime. The props stay on the contract rather than being
          ripped out, so `variationCount` still drives the grouped rows in the list body — only the row's
          own toggle is gone. */}
      {SHOW_VARIATIONS_TOGGLE && variationCount > 0 && onToggleVariations ? (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className={cn(
            "relative size-7 bg-transparent hover:bg-transparent",
            variationsExpanded ? "text-primary" : null,
          )}
          aria-label={`${variationsExpanded ? "Hide" : "Show"} ${variationCount} variation${
            variationCount === 1 ? "" : "s"
          } of ${label}`}
          aria-expanded={variationsExpanded}
          title={`${variationCount} variation${variationCount === 1 ? "" : "s"}`}
          data-uniscenario-variations-toggle=""
          onClick={() => onToggleVariations(document)}
        >
          <GitBranch className="size-3.5" aria-hidden="true" />
          <span className="absolute -right-0.5 -top-0.5 flex min-w-3 items-center justify-center bg-primary px-0.5 font-meta text-micro font-bold leading-3 text-primary-foreground">
            {variationCount}
          </span>
        </Button>
      ) : null}
      {/*
        `aria-disabled` rather than `disabled`, so the reason is reachable.

        A `disabled` button receives no pointer events, which means neither a
        Radix tooltip nor the native `title` fires on hover — the control simply
        did nothing and said nothing about why. Keeping it enabled to the
        browser and inert in the handler lets the tooltip explain itself, while
        `aria-disabled` still announces the state to assistive tech.
      */}
      <TooltipProvider delayDuration={150}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className={cn(
                "size-7 bg-transparent hover:bg-transparent hover:text-foreground",
                renderActive
                  ? "text-red-300"
                  : renderIconClassName(renderState),
                renderDisabled && "cursor-not-allowed opacity-50 hover:text-current",
              )}
              aria-label={`Render ${label}`}
              aria-pressed={renderActive}
              aria-disabled={renderDisabled || undefined}
              data-render-state={renderState}
              data-render-active={renderActive ? "true" : undefined}
              data-render-disabled-reason={renderDisabled ? "no-sensor-profile" : undefined}
              onClick={() => {
                if (renderDisabled) return;
                onRenderDocument(document);
              }}
            >
              <Video className="size-3.5" aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {renderIconTitle(renderState, document.hasSensorProfile)}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
}

/**
 * One document in the list.
 *
 * Two layouts, as in v1: compact (one line, title and actions) and advanced (a full-width content
 * column plus actions, adding tag pills, the last-editor line and the rating widget). Advanced mode
 * is the gate that reveals the review affordances, so the compact row stays a navigation list.
 *
 * The drop target is the whole row and it accepts both a real HTML5 drag and a bare pointer drag —
 * v1 wired both because the tag chips are draggable `div`s and a pointer-down that never crosses the
 * drag threshold still has to land somewhere.
 */
export function UniScenarioDocumentRow({
  document,
  datasetId,
  active,
  advancedMode,
  tagEditorMode,
  mutable,
  busy,
  renaming,
  renameDraft,
  editActive = false,
  renderActive = false,
  renderDimmed = false,
  renderInProgress,
  labelByMap = false,
  variationCount = 0,
  variationsExpanded = false,
  ratingAggregate,
  ratingLoading = false,
  ratingSaving = false,
  ratingError = null,
  draggingTagId,
  draggingTagIdRef,
  onClearDraggingTag,
  onAssignTag,
  onRenameDraftChange,
  onSetRenamingDocumentId,
  onCommitRename,
  onOpenDocument,
  onEditDocument,
  onExitEdit,
  onRenderDocument,
  onDownloadDocument,
  onDuplicateDocument,
  onEditDetails,
  onDeleteDocument,
  onSetRating,
  onToggleVariations,
  onError,
  onNotice,
}: UniScenarioDocumentRowProps) {
  const [tagDropTarget, setTagDropTarget] = useState(false);
  const lastEditorName = documentLastEditorName(document);
  const editedLabel = documentEditedAtLabel(document);
  const label = labelByMap ? documentMapLabel(document) : documentName(document);
  const isVariation =
    document.derivationKind === "variation" || document.derivationKind === "cross_map_variation";

  const clearTagDropTarget = () => setTagDropTarget(false);
  const dropTagFromPointer = (event: { preventDefault: () => void; stopPropagation: () => void }) => {
    const tagId = draggingTagIdRef.current ?? draggingTagId;
    if (!tagId) return;
    event.preventDefault();
    event.stopPropagation();
    onAssignTag(document.id, tagId);
    clearTagDropTarget();
    onClearDraggingTag();
  };

  return (
    <div
      data-uniscenario-document-card=""
      data-document-id={document.id}
      data-uniscenario-tag-drop-target={tagDropTarget ? "" : undefined}
      style={{ viewTransitionName: documentCardTransitionName(document.id) }}
      onDragEnter={
        tagEditorMode
          ? (event) => {
              if (!event.dataTransfer.types.includes(UNISCENARIO_TAG_DRAG_MIME)) return;
              event.preventDefault();
              setTagDropTarget(true);
            }
          : undefined
      }
      onDragOver={
        tagEditorMode
          ? (event) => {
              if (!event.dataTransfer.types.includes(UNISCENARIO_TAG_DRAG_MIME)) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "copy";
              setTagDropTarget(true);
            }
          : undefined
      }
      onDragLeave={
        tagEditorMode
          ? (event) => {
              // Moving between the row's own children fires dragleave on the row; only a real exit
              // should clear the highlight.
              if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
              clearTagDropTarget();
            }
          : undefined
      }
      onDrop={
        tagEditorMode
          ? (event) => {
              const tagId = event.dataTransfer.getData(UNISCENARIO_TAG_DRAG_MIME);
              if (!tagId) return;
              event.preventDefault();
              onAssignTag(document.id, tagId);
              clearTagDropTarget();
            }
          : undefined
      }
      onPointerEnter={
        tagEditorMode
          ? () => {
              if (!draggingTagIdRef.current && !draggingTagId) return;
              setTagDropTarget(true);
            }
          : undefined
      }
      onPointerLeave={tagEditorMode ? () => tagDropTarget && clearTagDropTarget() : undefined}
      onPointerUp={tagEditorMode ? dropTagFromPointer : undefined}
      className={cn(
        "group render-surface-motion border-0 border-b border-white/10 bg-transparent px-2 transition-colors",
        advancedMode
          ? "grid min-h-20 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 py-3"
          : "flex min-h-10 items-center gap-2 py-1.5",
        active
          ? "border-l-2 border-l-primary text-foreground"
          : "border-l-2 border-l-transparent hover:border-l-primary/60",
        tagDropTarget
          ? "border-l-primary text-primary"
          : null,
        tagEditorMode && draggingTagId ? "cursor-copy hover:border-l-primary" : null,
        // Receding, not hiding: the author still needs to read the other scenarios to switch to one,
        // and hover restores full strength so the list stays browsable while a render is open.
        renderDimmed ? "opacity-45 hover:opacity-100" : null,
        renderActive ? "bg-primary/[0.07]" : null,
      )}
      data-render-dimmed={renderDimmed ? "true" : undefined}
    >
      <div className="min-w-0 flex-1">
        <button
          type="button"
          className={cn(
            "block w-full truncate text-left font-medium text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
            advancedMode ? "text-sm" : "text-[13px]",
          )}
          onClick={() => onOpenDocument(document)}
          aria-label={`Open ${label}`}
        >
          {label}
        </button>
        {!advancedMode && isVariation ? (
          <span
            data-uniscenario-variation-tag=""
            className="mt-1 mr-1 inline-flex rounded-full border border-sky-400/45 bg-sky-400/10 px-1.5 py-0.5 font-meta text-[9px] uppercase tracking-meta-tight text-sky-300"
          >
            Variation
          </span>
        ) : null}
        {!labelByMap ? (
          <div
            className="mt-1 line-clamp-2 text-[12px] leading-snug text-white/70"
            data-uniscenario-document-description=""
          >
            {document.description?.trim() || "No description"}
          </div>
        ) : null}
        {advancedMode && (
          tagDropTarget || document.tags.length > 0 || document.contentTags.length > 0
        ) ? (
          <div
            className="mt-2 flex flex-wrap gap-1.5"
            aria-label={`Tags for ${label}`}
            data-uniscenario-tag-pills=""
          >
            {tagDropTarget ? (
              <span
                data-uniscenario-tag-drop-prompt=""
                className="rounded-full border border-primary/70 bg-primary/15 px-2 py-0.5 font-meta text-[9px] uppercase tracking-meta-tight text-primary"
              >
                Let go to apply tag
              </span>
            ) : null}
            {document.tags.map((tag) => (
              <span
                key={tag.id}
                className="rounded-full border px-2 py-0.5 font-meta text-[9px] uppercase tracking-meta-tight"
                style={tagChipStyle(tag.color)}
              >
                {tag.label}
              </span>
            ))}
            {/* Content tags are part of the hashed scenario content, so they remain read-only. */}
            {document.contentTags.map((tag) => (
              <span
                key={`content-${tag}`}
                title="Authored in the scenario content — not editable here"
                className="rounded-full border border-dashed border-border px-2 py-0.5 font-meta text-[9px] uppercase tracking-meta-tight text-muted-foreground"
              >
                {tag}
              </span>
            ))}
          </div>
        ) : null}
        {advancedMode && (lastEditorName || editedLabel) ? (
          <div className="mt-1 flex flex-col gap-0.5 font-meta text-micro uppercase tracking-meta text-white/70">
            {lastEditorName ? (
              <div className="truncate" data-uniscenario-last-edited-by="">
                {`Last edited by: ${lastEditorName}`}
              </div>
            ) : null}
            {editedLabel ? (
              <div className="truncate" data-uniscenario-edited-at="">
                {`Edited: ${editedLabel}`}
              </div>
            ) : null}
          </div>
        ) : null}
        {advancedMode ? (
          <UniScenarioRating
            aggregate={ratingAggregate}
            error={ratingError}
            loading={ratingLoading}
            saving={ratingSaving}
            documentName={label}
            onSetRating={onSetRating}
          />
        ) : null}
      </div>
      <DocumentActionCluster
        document={document}
        datasetId={datasetId}
        mutable={mutable}
        busy={busy}
        renaming={renaming}
        renameDraft={renameDraft}
        editActive={editActive}
        renderActive={renderActive}
        renderInProgress={renderInProgress}
        variationCount={variationCount}
        variationsExpanded={variationsExpanded}
        onRenameDraftChange={onRenameDraftChange}
        onSetRenamingDocumentId={onSetRenamingDocumentId}
        onCommitRename={onCommitRename}
        onEditDocument={onEditDocument}
        onExitEdit={onExitEdit}
        onRenderDocument={onRenderDocument}
        onDownloadDocument={onDownloadDocument}
        onDuplicateDocument={onDuplicateDocument}
        onEditDetails={onEditDetails}
        onDeleteDocument={onDeleteDocument}
        onToggleVariations={onToggleVariations}
        onError={onError}
        onNotice={onNotice}
      />
    </div>
  );
}
