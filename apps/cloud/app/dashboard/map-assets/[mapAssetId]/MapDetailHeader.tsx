"use client";

import Link from "next/link";
import {
  ArrowLeft,
  Camera,
  Copy,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
} from "lucide-react";
import type { MapAsset } from "@simcloud/shared";
import {
  TopBarActionsPortal,
  TopBarTrailingPortal,
} from "@/app/components/TopBarSlot";
import { Button } from "@/app/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/app/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/app/components/ui/tooltip";
import { cn } from "@/app/lib/utils";
import { toast } from "sonner";
import { MapSwitcherDropdown } from "./MapSwitcherDropdown";

export type ViewMode = "2d" | "3d";

interface MapDetailHeaderProps {
  asset: MapAsset;
  allAssets: MapAsset[];
  onEdit: () => void;
  onPopulateMetadata: () => void;
  onEnrich: () => void;
  onRefreshSearchIndex: () => void;
  onGenerateThumbnail: () => void;
  onSwitchMap: (mapAssetId: string) => void;
  onCreateBlankScenario: () => void;
  canCreateBlankScenario?: boolean;
  populateBusy?: boolean;
  enrichBusy?: boolean;
  refreshSearchIndexBusy?: boolean;
  thumbnailBusy?: boolean;
  createBlankBusy?: boolean;
}

export function MapDetailHeader({
  asset,
  allAssets,
  onEdit,
  onPopulateMetadata,
  onEnrich,
  onRefreshSearchIndex,
  onGenerateThumbnail,
  onSwitchMap,
  onCreateBlankScenario,
  canCreateBlankScenario = true,
  populateBusy = false,
  enrichBusy = false,
  refreshSearchIndexBusy = false,
  thumbnailBusy = false,
  createBlankBusy = false,
}: MapDetailHeaderProps) {
  function copyMapId() {
    navigator.clipboard.writeText(asset.map_asset_id).then(() => {
      toast.success("Map ID copied");
    }).catch(() => {});
  }

  return (
    <>
      <TopBarActionsPortal>
        <div className="flex min-w-0 items-center gap-2">
          <Link
            href="/dashboard/map-assets"
            className="flex h-10 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-foreground/[0.08] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ArrowLeft className="size-3.5" />
            <span className="hidden lg:inline">Back to Maps</span>
            <span className="lg:hidden">Back</span>
          </Link>

          <div className="hidden h-5 w-px shrink-0 bg-border md:block" />

          <MapSwitcherDropdown currentAsset={asset} allAssets={allAssets} onSwitchMap={onSwitchMap} />
        </div>
      </TopBarActionsPortal>

      <TopBarTrailingPortal>
        <Button
          variant="secondary"
          size="sm"
          className="gap-1.5 rounded-md"
          onClick={onCreateBlankScenario}
          disabled={createBlankBusy || !canCreateBlankScenario}
          title={
            canCreateBlankScenario
              ? undefined
              : "This map is not available in CARLA yet."
          }
        >
          <Plus className="size-3.5" />
          {createBlankBusy ? "Creating..." : "Create Blank Scenario"}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="ml-2 size-10 shrink-0 rounded-md text-foreground/70 transition-colors hover:bg-foreground/[0.08] hover:text-foreground"
            >
              <MoreHorizontal size={22} strokeWidth={1.75} />
              <span className="sr-only">Actions</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <TooltipProvider delayDuration={200}>
              <DropdownMenuItem onClick={onEdit}>
                <Pencil className="mr-2 size-3.5" />
                Edit Map
              </DropdownMenuItem>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuItem
                    onClick={onPopulateMetadata}
                    disabled={populateBusy}
                  >
                    <RefreshCw
                      className={cn(
                        "mr-2 size-3.5",
                        populateBusy && "animate-spin",
                      )}
                    />
                    Re-extract Metadata
                  </DropdownMenuItem>
                </TooltipTrigger>
                <TooltipContent side="left" className="max-w-xs text-xs">
                  Recalculate metadata and refresh the local search index.
                </TooltipContent>
              </Tooltip>
              <DropdownMenuItem onClick={onEnrich} disabled>
                <RefreshCw
                  className={cn(
                    "mr-2 size-3.5",
                    enrichBusy && "animate-spin",
                  )}
                />
                Enrichment unavailable locally
              </DropdownMenuItem>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuItem
                    onClick={onRefreshSearchIndex}
                    disabled={refreshSearchIndexBusy}
                  >
                    <RefreshCw
                      className={cn(
                        "mr-2 size-3.5",
                        refreshSearchIndexBusy && "animate-spin",
                      )}
                    />
                    Refresh Search Index
                  </DropdownMenuItem>
                </TooltipTrigger>
                <TooltipContent side="left" className="max-w-xs text-xs">
                  Refreshes the search index just from the current metadata — no repopulation or re-enrichment.
                </TooltipContent>
              </Tooltip>
              <DropdownMenuItem
                onClick={onGenerateThumbnail}
                disabled={thumbnailBusy}
              >
                <Camera
                  className={cn(
                    "mr-2 size-3.5",
                    thumbnailBusy && "animate-pulse",
                  )}
                />
                Generate Thumbnail
              </DropdownMenuItem>
              <DropdownMenuItem onClick={copyMapId}>
                <Copy className="mr-2 size-3.5" />
                Copy Map ID
              </DropdownMenuItem>
            </TooltipProvider>
          </DropdownMenuContent>
        </DropdownMenu>
      </TopBarTrailingPortal>
    </>
  );
}
