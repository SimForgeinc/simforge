const EXT_TO_CONTENT_TYPE: Record<string, string> = {
  glb: "model/gltf-binary",
  gltf: "model/gltf+json",
  json: "application/json",
  hdr: "application/octet-stream",
  bin: "application/octet-stream",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  mp4: "video/mp4",
  webp: "image/webp",
};

/** Map a filename's extension to a MIME content type. Defaults to `application/octet-stream`. */
export function contentTypeForExtension(filename: string): string {
  const ext = filename.includes(".")
    ? filename.split(".").pop()!.toLowerCase()
    : "";
  return EXT_TO_CONTENT_TYPE[ext] ?? "application/octet-stream";
}
