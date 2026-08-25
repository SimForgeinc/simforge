"use client";

import { Boxes, Map as MapIcon, Upload } from "lucide-react";
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
    "Scenario-ready 3D models stored in the local library.",
  maps: "Local map versions available for scenario authoring.",
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
          eyebrow="Local library"
          title="Assets"
          description={SECTION_DESCRIPTION[section]}
          actions={
            <Button type="button" variant="outline" onClick={onUpload}>
              <Upload aria-hidden="true" />
              {section === "maps" ? "Import map" : "Import model"}
            </Button>
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
