import { Paperclip } from "lucide-react";
import { Button } from "@/app/components/ui/button";
import { Badge } from "@/app/components/ui/badge";
import { artifactTypeFromExtension } from "@/app/lib/maps/frontend/add-map-utils";
import { UploadStatusBadge, type TrackedUpload } from "./UploadStatusBadge";

interface AdditionalArtifactsPanelProps {
  files: File[];
  uploads: Record<string, TrackedUpload>;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onFilesChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
}

/** Optional extra artifacts (FBX, MP4, images) beyond the three required map files. */
export function AdditionalArtifactsPanel({
  files,
  uploads,
  inputRef,
  onFilesChange,
}: AdditionalArtifactsPanelProps) {
  return (
    <div className="border-t border-border pt-5">
      <h2 className="mb-1 text-sm font-semibold text-foreground">Additional artifacts</h2>
      <p className="mb-3 text-xs text-muted-foreground">
        Optional. Extra media or formats (e.g. .fbx, .mp4, images) beyond the three required files above.
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => inputRef.current?.click()}
      >
        <Paperclip className="mr-1.5 size-3.5" />
        {files.length > 0 ? "Add more files" : "Choose files"}
      </Button>
      <input
        id="map-artifacts"
        type="file"
        multiple
        ref={inputRef}
        className="hidden"
        onChange={onFilesChange}
      />
      {files.length > 0 && (
        <ul className="mt-2 space-y-1">
          {files.map((f, i) => (
            <li key={f.name} className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="truncate">{f.name}</span>
              <Badge variant="outline" className="shrink-0 font-mono text-[10px]">
                {artifactTypeFromExtension(f.name) ?? "?"}
              </Badge>
              <UploadStatusBadge upload={uploads[`artifact-${i}`]} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
