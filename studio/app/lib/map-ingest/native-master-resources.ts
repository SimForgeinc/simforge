type NativeMasterDocument = {
  buffers?: Array<{ uri?: string }>;
  images?: Array<{ uri?: string }>;
  textures?: Array<{ source?: number; extensions?: { KHR_texture_basisu?: { source: number } } }>;
};

/** KHR_texture_basisu replaces a texture's archival raster source at runtime. */
export function nativeMasterResources(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("native master is not a JSON object");
  const document = value as NativeMasterDocument;
  for (const field of ["buffers", "images", "textures"] as const) {
    if (document[field] !== undefined && !Array.isArray(document[field])) throw new Error(`native master ${field} is not an array`);
  }
  const resources = [...(document.buffers ?? [])];
  const images = new Set<number>();
  for (const texture of document.textures ?? []) {
    const index = texture.extensions?.KHR_texture_basisu?.source ?? texture.source;
    if (index === undefined || !Number.isSafeInteger(index) || index < 0) throw new Error("native texture has no valid image source");
    images.add(index);
  }
  for (const index of images) {
    const image = document.images?.[index];
    if (!image) throw new Error(`native master references missing image ${index}`);
    resources.push(image);
  }
  return resources.flatMap((resource) => resource.uri && !resource.uri.startsWith("data:") ? [resource.uri] : []);
}
