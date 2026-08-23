"use client";

import { Boxes, Map as MapIcon, Sparkles, Upload } from "lucide-react";
import { Button } from "@/app/components/ui/button";
import { PageHeader } from "@/app/components/ui/page-header";
import { AssetGallerySegmented } from "./AssetGallerySegmented";

/** The two things this library holds. Models and maps share nothing but the shelf. */
export type GallerySection = "models" | "maps";

const SECTION_OPTIONS = [
  { value: "models", label: "Models", icon: Boxes },
  { value: "maps", label: "Maps", icon: MapIcon },
] as const;

const SECTION_DESCRIPTION = {
  models:
    "Every scenario-ready 3D model the SimForge community has published. Upload a model to add it to the local library.",
  maps: "Published map versions every scenario in this workspace can be authored on.",
} as const satisfies Record<GallerySection, string>;

export function AssetGalleryHeader({
  section,
  onSectionChange,
  onUpload,
}: {
  section: GallerySection;
  onSectionChange: (section: GallerySection) => void;
  onUpload: () => void;
}) {
  // Padding outside the centred column, matching `AssetsTabs` above it — the
  // two used to inset differently and their left edges did not line up.
  return (
    <div className="border-b border-border bg-background px-5 sm:px-8">
      <div className="mx-auto max-w-[1500px]">
        <PageHeader
          className="border-b-0 bg-transparent px-0 pb-4 sm:px-0"
          eyebrow="Public library"
          title="Asset Gallery"
          description={SECTION_DESCRIPTION[section]}
          actions={
            <>
              {/* Generating is the headline capability and leads the pair, but it
                  only produces a model — there is no map generator behind it, so
                  in the Maps section the button would be a promise nothing keeps. */}
              {section === "models" ? (
                <Button type="button" disabled title="Meshy generation is unavailable in local mode">
                  <Sparkles aria-hidden="true" />
                  Generate asset · In development
                </Button>
              ) : null}
              <Button type="button" variant="outline" onClick={onUpload}>
                <Upload aria-hidden="true" />
                {section === "maps" ? "Upload new map" : "Upload new asset"}
              </Button>
            </>
          }
        />
        <AssetGallerySegmented
          label="Library section"
          value={section}
          options={SECTION_OPTIONS}
          onChange={onSectionChange}
          className="mb-4"
        />
      </div>
    </div>
  );
}
