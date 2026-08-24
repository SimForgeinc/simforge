"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent } from "react";
import { ChevronDown, MoreHorizontal, Pencil, Plus, Tags, Trash2 } from "lucide-react";
import type {
  ScenarioDocumentSummaryDto,
  ScenarioRatingAggregateDto,
  ScenarioTagDto,
} from "@/app/lib/scenario/contracts";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { CloudActivityIndicator } from "@/app/components/CloudLoadingSurface";
import { WorkspacePaneLoading } from "@/app/components/WorkspacePaneLoading";
import { cn } from "@/app/lib/utils";
import {
  groupDocumentsByMap,
  groupVariationsBySource,
  type ScenarioMapGroup,
  type ScenarioMapOption,
} from "./document-map-groups";
import { SCENARIO_TAG_DRAG_MIME, ScenarioDocumentRow } from "./ScenarioDocumentRow";
import {
  DEFAULT_SCENARIO_TAG_COLOR,
  DEFAULT_SCENARIO_TAG_COLORS,
  scenarioListCache,
} from "./scenarioListCache";

type SharedRowHandlers = Pick<
  React.ComponentProps<typeof ScenarioDocumentRow>,
  | "onAssignTag"
  | "onRenameDraftChange"
  | "onSetRenamingDocumentId"
  | "onCommitRename"
  | "onOpenDocument"
  | "onEditDocument"
  | "onExitEdit"
  | "onRenderDocument"
  | "onDownloadDocument"
  | "onDuplicateDocument"
  | "onEditDetails"
  | "onDeleteDocument"
  | "onError"
  | "onNotice"
  | "onClearDraggingTag"
>;

export type ScenarioDocumentCreatorProps = SharedRowHandlers & {
  datasetId: string;
  datasetEditable: boolean;
  documents: ScenarioDocumentSummaryDto[];
  totalDocumentCount: number;
  documentsLoading: boolean;
  documentsLoadingMore: boolean;
  hasMoreDocuments: boolean;
  onLoadMoreDocuments: () => void;
  availableMaps: ReadonlyArray<ScenarioMapOption>;
  advancedMode: boolean;
  tagEditorMode: boolean;
  tags: ScenarioTagDto[];
  ratingAggregates: Record<string, ScenarioRatingAggregateDto>;
  ratingsLoading: boolean;
  ratingError: string | null;
  ratingSavingIds: ReadonlySet<string>;
  selectedTagFilter: string | null;
  newTagName: string;
  newTagColor: string;
  onNewTagNameChange: (next: string) => void;
  onNewTagColorChange: (next: string) => void;
  onCreateTag: () => void;
  onRenameTag: (tagId: string, label: string) => void;
  onSetTagColor: (tagId: string, color: string) => void;
  onDeleteTag: (tagId: string) => void;
  onSelectTagFilter: (tagId: string | null) => void;
  onSetRating: (documentId: string, rating: number) => void;
  onPersistViewState: () => void;
  activeDocumentId: string | null | undefined;
  /** The document open in the editor, if any. Drives the pencil's toggled state. */
  editActiveDocumentId?: string | null;
  renderActiveDocumentId?: string | null;
  busyDocumentId: string | null;
  renamingDocumentId: string | null;
  renameDraft: string;
  renderInProgress: boolean;
};

/**
 * The document list body: map groups, the tag rail, the load-more control.
 *
 * Ported from v1's `ScenarioCreator`. One group is open at a time — opening another closes the first —
 * which is what makes the map cards readable as a table of contents rather than as a wall.
 */
export function ScenarioDocumentCreator({
  datasetId,
  datasetEditable,
  documents,
  totalDocumentCount,
  documentsLoading,
  documentsLoadingMore,
  hasMoreDocuments,
  onLoadMoreDocuments,
  availableMaps,
  advancedMode,
  tagEditorMode,
  tags,
  ratingAggregates,
  ratingsLoading,
  ratingError,
  ratingSavingIds,
  selectedTagFilter,
  newTagName,
  newTagColor,
  onNewTagNameChange,
  onNewTagColorChange,
  onCreateTag,
  onRenameTag,
  onSetTagColor,
  onDeleteTag,
  onSelectTagFilter,
  onSetRating,
  onPersistViewState,
  activeDocumentId,
  editActiveDocumentId,
  renderActiveDocumentId,
  busyDocumentId,
  renamingDocumentId,
  renameDraft,
  renderInProgress,
  ...rowHandlers
}: ScenarioDocumentCreatorProps) {
  const showTagEditorTools = advancedMode && tagEditorMode;
  const documentGroups = useMemo(
    () => groupDocumentsByMap(documents, availableMaps),
    [availableMaps, documents],
  );
  const variationsBySource = useMemo(() => groupVariationsBySource(documents), [documents]);
  const [expandedVariationRootIds, setExpandedVariationRootIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [expandedMapKeys, setExpandedMapKeys] = useState<Set<string>>(
    () => new Set([...(scenarioListCache.expandedMapLabelsByDataset[datasetId] ?? [])].slice(0, 1)),
  );
  const [draggingTagId, setDraggingTagId] = useState<string | null>(null);
  const draggingTagIdRef = useRef<string | null>(null);

  const beginTagDrag = (tagId: string) => {
    draggingTagIdRef.current = tagId;
    setDraggingTagId(tagId);
  };
  const clearTagDrag = () => {
    draggingTagIdRef.current = null;
    setDraggingTagId(null);
  };

  useEffect(() => {
    setExpandedMapKeys(
      new Set([...(scenarioListCache.expandedMapLabelsByDataset[datasetId] ?? [])].slice(0, 1)),
    );
  }, [datasetId]);

  // A pointer drag can end anywhere — including outside the window — so the drag latch is cleared
  // from the window, not from the row that happened to be under the cursor.
  useEffect(() => {
    if (!draggingTagId) return;
    window.addEventListener("pointerup", clearTagDrag);
    window.addEventListener("pointercancel", clearTagDrag);
    return () => {
      window.removeEventListener("pointerup", clearTagDrag);
      window.removeEventListener("pointercancel", clearTagDrag);
    };
  }, [draggingTagId]);

  useEffect(() => {
    if (!advancedMode) clearTagDrag();
  }, [advancedMode]);

  const toggleMapGroup = (groupKey: string) => {
    setExpandedMapKeys((current) => {
      const next = current.has(groupKey) ? new Set<string>() : new Set([groupKey]);
      scenarioListCache.expandedMapLabelsByDataset = {
        ...scenarioListCache.expandedMapLabelsByDataset,
        [datasetId]: next,
      };
      onPersistViewState();
      return next;
    });
  };
  const anyMapExpanded = expandedMapKeys.size > 0;

  const toggleVariationsFor = (document: ScenarioDocumentSummaryDto) => {
    setExpandedVariationRootIds((current) => {
      const next = new Set(current);
      if (next.has(document.id)) next.delete(document.id);
      else next.add(document.id);
      return next;
    });
  };

  const renderRow = (
    document: ScenarioDocumentSummaryDto,
    options: { labelByMap?: boolean; nested?: boolean } = {},
  ) => {
    const variations = options.nested ? [] : (variationsBySource.get(document.id) ?? []);
    const variationsExpanded = variations.length > 0 && expandedVariationRootIds.has(document.id);
    const row = (
      <ScenarioDocumentRow
        key={document.id}
        document={document}
        datasetId={datasetId}
        active={document.id === activeDocumentId}
        advancedMode={advancedMode}
        tagEditorMode={tagEditorMode}
        mutable={datasetEditable}
        busy={busyDocumentId === document.id}
        renaming={renamingDocumentId === document.id}
        renameDraft={renameDraft}
        editActive={Boolean(editActiveDocumentId) && editActiveDocumentId === document.id}
        renderActive={renderActiveDocumentId === document.id}
        renderDimmed={
          Boolean(renderActiveDocumentId) && renderActiveDocumentId !== document.id
        }
        renderInProgress={renderInProgress}
        labelByMap={options.labelByMap ?? false}
        variationCount={variations.length}
        variationsExpanded={variationsExpanded}
        availableTags={tags}
        ratingAggregate={ratingAggregates[document.id]}
        ratingLoading={ratingsLoading}
        ratingSaving={ratingSavingIds.has(document.id)}
        ratingError={ratingError}
        draggingTagId={draggingTagId}
        draggingTagIdRef={draggingTagIdRef}
        onSetRating={(rating) => onSetRating(document.id, rating)}
        onToggleVariations={options.nested ? undefined : toggleVariationsFor}
        {...rowHandlers}
      />
    );
    if (!variationsExpanded) return row;
    return (
      <div key={document.id} data-scenario-with-variations="">
        {row}
        <div
          className="ml-4 border-l border-primary/30"
          data-scenario-variations-sublist=""
        >
          {/* One nesting level. A variation of a variation is still listed under its own source. */}
          {variations.map((variation) => renderRow(variation, { labelByMap: true, nested: true }))}
        </div>
      </div>
    );
  };

  return (
    <div
      className={cn("flex h-full min-h-0", showTagEditorTools ? "flex-row" : "flex-col")}
      data-scenario-advanced-mode={advancedMode ? "" : undefined}
    >
      {showTagEditorTools ? (
        <ScenarioTagTools
          tags={tags}
          documentCount={totalDocumentCount}
          visibleDocumentCount={documents.length}
          selectedTagFilter={selectedTagFilter}
          tagEditorMode={tagEditorMode}
          newTagName={newTagName}
          newTagColor={newTagColor}
          onNewTagNameChange={onNewTagNameChange}
          onNewTagColorChange={onNewTagColorChange}
          onCreateTag={onCreateTag}
          onRenameTag={onRenameTag}
          onSetTagColor={onSetTagColor}
          onDeleteTag={onDeleteTag}
          onSelectTagFilter={onSelectTagFilter}
          onBeginTagDrag={beginTagDrag}
        />
      ) : null}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {!datasetEditable ? (
          <div className="border-b border-border px-3 py-3">
            <div className="border-l border-primary/60 pl-3 text-xs text-foreground">
              This is a shared or read-only dataset. Open scenarios from it, or copy one into a
              workspace dataset before editing.
            </div>
          </div>
        ) : null}
        <div className="min-h-0 flex-1 overflow-y-auto" data-testid="scenario-document-list">
          {documentsLoading && documents.length === 0 ? (
            <WorkspacePaneLoading
              className="min-h-24"
              hint="Reading scenarios and their saved revisions."
              message="Loading scenarios"
            />
          ) : documents.length === 0 ? (
            <div className="border-b border-white/10 px-3 py-4 text-sm text-muted-foreground">
              {totalDocumentCount > 0
                ? "No scenarios match the current filter."
                : "No scenarios in this dataset yet."}
            </div>
          ) : (
            <div className="space-y-0">
              {documentGroups.map((group) => (
                <MapDocumentGroup
                  key={group.groupKey}
                  group={group}
                  advancedMode={advancedMode}
                  expanded={expandedMapKeys.has(group.groupKey)}
                  anyMapExpanded={anyMapExpanded}
                  onToggle={() => toggleMapGroup(group.groupKey)}
                >
                  {group.documents.map((document) => renderRow(document))}
                </MapDocumentGroup>
              ))}
              {hasMoreDocuments ? (
                <div className="border-t border-white/10 p-3">
                  <Button
                    type="button"
                    variant="ghost"
                    className="h-9 w-full bg-transparent font-meta text-micro font-bold uppercase tracking-meta-wide hover:bg-transparent hover:text-primary"
                    disabled={documentsLoadingMore}
                    onClick={onLoadMoreDocuments}
                  >
                    {documentsLoadingMore ? (
                      <CloudActivityIndicator label="Loading scenarios…" />
                    ) : "Load 50 more scenarios"}
                  </Button>
                </div>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function MapDocumentGroup({
  group,
  advancedMode,
  expanded,
  anyMapExpanded,
  onToggle,
  children,
}: {
  group: ScenarioMapGroup;
  advancedMode: boolean;
  expanded: boolean;
  anyMapExpanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <section
      data-scenario-map-group=""
      data-map-version-id={group.mapVersionId || undefined}
      className={cn(
        "border-b border-white/15",
        anyMapExpanded && expanded ? "border-white/25" : null,
      )}
    >
      <button
        type="button"
        data-scenario-map-card=""
        aria-expanded={expanded}
        className={cn(
          "group/map relative w-full bg-transparent text-left transition-colors hover:text-primary focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-[-2px] focus-visible:outline-primary",
          advancedMode ? "min-h-[56px]" : "min-h-[64px]",
        )}
        onClick={onToggle}
      >
        <div
          className={cn(
            "flex min-h-[inherit] items-end justify-between gap-3 px-3",
            advancedMode ? "py-2" : "py-3",
          )}
        >
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-foreground">
              {group.displayLabel}
            </div>
            <div className="mt-1 font-meta text-micro uppercase tracking-meta-widest text-white/70">
              {group.documents.length} {group.documents.length === 1 ? "scenario" : "scenarios"}
            </div>
          </div>
          <span className="flex size-7 shrink-0 items-center justify-center text-foreground/70 transition-transform group-aria-expanded/map:rotate-180 motion-reduce:transition-none">
            <ChevronDown className="size-4" aria-hidden="true" />
          </span>
        </div>
      </button>
      {expanded ? (
        <div
          data-scenario-group-body=""
          className="space-y-0 border-t border-white/10"
        >
          {children}
        </div>
      ) : null}
    </section>
  );
}

/**
 * The tag rail: create, recolour, rename, delete, filter, and drag onto a row.
 *
 * Two modes on one rail, as in v1. In filter mode a tag is a button that narrows the list; in editor
 * mode it is a draggable handle and clicking it does nothing, because the same gesture cannot mean
 * both "show me these" and "apply this".
 */
function ScenarioTagTools({
  tags,
  documentCount,
  visibleDocumentCount,
  selectedTagFilter,
  tagEditorMode,
  newTagName,
  newTagColor,
  onNewTagNameChange,
  onNewTagColorChange,
  onCreateTag,
  onRenameTag,
  onSetTagColor,
  onDeleteTag,
  onSelectTagFilter,
  onBeginTagDrag,
}: {
  tags: ScenarioTagDto[];
  documentCount: number;
  visibleDocumentCount: number;
  selectedTagFilter: string | null;
  tagEditorMode: boolean;
  newTagName: string;
  newTagColor: string;
  onNewTagNameChange: (next: string) => void;
  onNewTagColorChange: (next: string) => void;
  onCreateTag: () => void;
  onRenameTag: (tagId: string, label: string) => void;
  onSetTagColor: (tagId: string, color: string) => void;
  onDeleteTag: (tagId: string) => void;
  onSelectTagFilter: (tagId: string | null) => void;
  onBeginTagDrag: (tagId: string) => void;
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const [editingTagId, setEditingTagId] = useState<string | null>(null);
  const [editingTagName, setEditingTagName] = useState("");
  const [openTagMenuId, setOpenTagMenuId] = useState<string | null>(null);

  const commitTagRename = () => {
    if (!editingTagId) return;
    onRenameTag(editingTagId, editingTagName);
    setEditingTagId(null);
    setEditingTagName("");
  };

  return (
    <aside
      className={cn(
        "min-h-0 w-[152px] shrink-0 overflow-y-auto border-r p-2 transition-colors",
        tagEditorMode ? "border-primary/80 bg-primary/10" : "border-white/10 bg-black/20",
      )}
      data-scenario-tag-tools-mode={tagEditorMode ? "editor" : "filter"}
    >
      <div className="space-y-3">
        <section className="relative space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 font-meta text-micro uppercase tracking-meta-widest text-muted-foreground">
              <Tags className="size-3.5 text-primary" aria-hidden="true" />
              {tagEditorMode ? "Add Tags" : "Filter"}
            </div>
            {tagEditorMode ? (
              <Button
                type="button"
                size="icon"
                variant="outline"
                className="size-6 border-primary/40 text-primary"
                aria-label="Add scenario tag"
                aria-expanded={createOpen}
                onClick={() => setCreateOpen((open) => !open)}
              >
                <Plus className="size-3" aria-hidden="true" />
              </Button>
            ) : null}
          </div>
          {tagEditorMode && createOpen ? (
            <form
              data-testid="scenario-tag-create-form"
              className="absolute right-0 top-8 z-30 w-full space-y-1.5 border border-primary/40 bg-popover p-1.5 shadow-lg"
              onSubmit={(event) => {
                event.preventDefault();
                onCreateTag();
                setCreateOpen(false);
              }}
            >
              <div className="flex gap-1.5">
                <Input
                  autoFocus
                  type="text"
                  aria-label="New tag name"
                  value={newTagName}
                  onChange={(event) => onNewTagNameChange(event.target.value)}
                  placeholder="Create tag"
                  className="h-7 min-w-0 flex-1 px-2 text-meta"
                />
                <Button
                  type="submit"
                  size="sm"
                  variant="outline"
                  className="h-7 border-primary/60 px-2 text-micro uppercase tracking-meta text-primary"
                >
                  Add
                </Button>
              </div>
              <ScenarioTagColorPicker
                selectedColor={newTagColor}
                onSelectColor={onNewTagColorChange}
                label="New tag color"
              />
            </form>
          ) : null}
        </section>

        <section className="space-y-1.5">
          <div className="font-meta text-micro uppercase tracking-meta-widest text-muted-foreground">
            {tagEditorMode ? "Drag tags" : "Sort by tags"}
          </div>
          <p className="text-meta leading-4 text-muted-foreground">
            {tagEditorMode
              ? "Drag a tag onto a scenario row to assign it."
              : "Click a tag to filter the scenario list."}
          </p>
          {!tagEditorMode ? (
            <Button
              type="button"
              variant={selectedTagFilter === null ? "default" : "outline"}
              onClick={() => onSelectTagFilter(null)}
              className="h-8 w-full justify-start px-3 text-xs"
            >
              All scenarios
            </Button>
          ) : null}
          <div className="flex flex-col gap-1.5">
            {tags.length === 0 ? (
              <div className="border border-dashed border-border px-2 py-3 text-xs text-muted-foreground">
                {tagEditorMode
                  ? "Create tags, then drag them onto scenario rows."
                  : "Create tags from Add Tags to filter scenarios."}
              </div>
            ) : (
              tags.map((tag) => {
                const color = tag.color ?? DEFAULT_SCENARIO_TAG_COLOR;
                const isFilter = selectedTagFilter === tag.id;
                return (
                  <div
                    key={tag.id}
                    draggable={tagEditorMode && editingTagId !== tag.id}
                    onPointerDown={(event) => {
                      if (!tagEditorMode || event.button !== 0 || editingTagId === tag.id) return;
                      onBeginTagDrag(tag.id);
                      setOpenTagMenuId(null);
                    }}
                    onDragStart={(event) => {
                      if (!tagEditorMode || editingTagId === tag.id) return;
                      startTagDrag(event, tag, onBeginTagDrag);
                    }}
                    className={cn(
                      "inline-flex min-h-8 w-full max-w-full items-center gap-1 border py-1 pl-3 pr-1 text-left text-xs transition-colors",
                      tagEditorMode ? "cursor-grab active:cursor-grabbing" : "cursor-pointer",
                    )}
                    style={
                      isFilter
                        ? {
                            borderColor: "hsl(var(--primary))",
                            backgroundColor: "hsl(var(--primary))",
                            color: "hsl(var(--primary-foreground))",
                          }
                        : {
                            borderColor: `color-mix(in srgb, ${color} 38%, transparent)`,
                            backgroundColor: `color-mix(in srgb, ${color} 10%, transparent)`,
                            color,
                          }
                    }
                    data-scenario-tag-id={tag.id}
                  >
                    {editingTagId === tag.id ? (
                      <input
                        autoFocus
                        value={editingTagName}
                        onChange={(event) => setEditingTagName(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            commitTagRename();
                          } else if (event.key === "Escape") {
                            event.preventDefault();
                            setEditingTagId(null);
                            setEditingTagName("");
                          }
                        }}
                        onBlur={commitTagRename}
                        aria-label={`Rename the ${tag.label} tag`}
                        className="h-6 min-w-0 flex-1 border border-primary/50 bg-background px-1.5 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() => onSelectTagFilter(tag.id)}
                        disabled={tagEditorMode}
                        aria-pressed={isFilter}
                        className="min-w-0 flex-1 truncate text-left"
                      >
                        {tag.label}
                      </button>
                    )}
                    {tagEditorMode ? (
                      <div className="relative">
                        <button
                          type="button"
                          // The chip itself starts a drag on pointerdown, so the menu button has to
                          // stop the event or opening the menu also arms a drag.
                          onPointerDown={(event) => event.stopPropagation()}
                          onClick={() =>
                            setOpenTagMenuId((current) => (current === tag.id ? null : tag.id))
                          }
                          aria-label={`Tag actions for ${tag.label}`}
                          aria-expanded={openTagMenuId === tag.id}
                          className="flex size-6 items-center justify-center text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <MoreHorizontal className="size-3.5" aria-hidden="true" />
                        </button>
                        {openTagMenuId === tag.id ? (
                          <div className="absolute right-0 top-7 z-40 w-32 space-y-1 border border-border bg-popover p-1 text-popover-foreground shadow-lg">
                            <ScenarioTagColorPicker
                              selectedColor={color}
                              onSelectColor={(nextColor) => onSetTagColor(tag.id, nextColor)}
                              label={`Color for ${tag.label}`}
                            />
                            <button
                              type="button"
                              className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              onClick={() => {
                                setEditingTagId(tag.id);
                                setEditingTagName(tag.label);
                                setOpenTagMenuId(null);
                              }}
                            >
                              <Pencil className="size-3" aria-hidden="true" />
                              Rename
                            </button>
                            <button
                              type="button"
                              className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs text-destructive hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              onClick={() => {
                                onDeleteTag(tag.id);
                                setOpenTagMenuId(null);
                              }}
                            >
                              <Trash2 className="size-3" aria-hidden="true" />
                              Delete
                            </button>
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                );
              })
            )}
          </div>
          {selectedTagFilter ? (
            <div className="font-meta text-micro uppercase tracking-meta text-muted-foreground">
              Showing {visibleDocumentCount} of {documentCount}
            </div>
          ) : null}
        </section>
      </div>
    </aside>
  );
}

function ScenarioTagColorPicker({
  selectedColor,
  onSelectColor,
  label,
}: {
  selectedColor: string;
  onSelectColor: (color: string) => void;
  label: string;
}) {
  const activeColor = (selectedColor ?? DEFAULT_SCENARIO_TAG_COLOR).toLowerCase();
  return (
    <div className="flex flex-wrap gap-1" role="group" aria-label={label}>
      {DEFAULT_SCENARIO_TAG_COLORS.map((color) => (
        <button
          key={color}
          type="button"
          className={cn(
            "size-4 border transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
            activeColor === color ? "border-foreground" : "border-border",
          )}
          style={{ backgroundColor: color }}
          aria-label={`Use tag color ${color}`}
          aria-pressed={activeColor === color}
          onClick={() => onSelectColor(color)}
        />
      ))}
    </div>
  );
}

/**
 * Arm an HTML5 drag with a snapshot of the chip as its drag image.
 *
 * The default drag image for a styled `div` is unreliable across browsers, and the chip's colour is
 * the only thing identifying which tag is in flight.
 */
function startTagDrag(
  event: DragEvent<HTMLDivElement>,
  tag: ScenarioTagDto,
  onBeginTagDrag: (tagId: string) => void,
) {
  onBeginTagDrag(tag.id);
  event.dataTransfer.effectAllowed = "copy";
  event.dataTransfer.setData(SCENARIO_TAG_DRAG_MIME, tag.id);
  event.dataTransfer.setData("text/plain", tag.label);

  const source = event.currentTarget;
  const dragImage = source.cloneNode(true) as HTMLElement;
  const rect = source.getBoundingClientRect();
  dragImage.style.position = "fixed";
  dragImage.style.top = "-1000px";
  dragImage.style.left = "-1000px";
  dragImage.style.width = `${rect.width}px`;
  dragImage.style.pointerEvents = "none";
  document.body.appendChild(dragImage);
  event.dataTransfer.setDragImage(dragImage, rect.width / 2, rect.height / 2);
  window.setTimeout(() => dragImage.remove(), 0);
}
