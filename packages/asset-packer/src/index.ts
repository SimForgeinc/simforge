import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const ASSET_PACK_SCHEMA_ID = "simforge-oss.asset-pack/v1" as const;
export const ASSET_PACK_SOURCE_SCHEMA_ID = "simforge-oss.asset-pack-source/v1" as const;

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const SafePackPathSchema = z.string().min(1).max(300).refine(
  (value) =>
    !path.posix.isAbsolute(value) &&
    !value.split("/").some((segment) => segment === "" || segment === "." || segment === "..") &&
    !value.includes("\\"),
  "must be a normalized relative POSIX path",
);
const DimsSchema = z.strictObject({
  l: z.number().positive(),
  w: z.number().positive(),
  h: z.number().positive(),
});
const SourceFileSchema = z.strictObject({
  source: z.string().min(1),
  path: SafePackPathSchema,
  mediaType: z.string().min(1).max(120),
});
const ManifestFileSchema = z.strictObject({
  path: SafePackPathSchema,
  sha256: Sha256Schema,
  size: z.number().int().positive(),
  mediaType: z.string().min(1).max(120),
});

export const AssetPackSourceSchema = z.strictObject({
  schema: z.literal(ASSET_PACK_SOURCE_SCHEMA_ID),
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  title: z.string().min(1).max(120),
  author: z.string().min(1).max(120),
  license: z.string().min(1).max(120),
  lane: z.enum(["browser", "carla-native"]),
  entries: z.array(
    z.strictObject({
      id: z.string().min(1).max(128),
      label: z.string().min(1).max(120),
      class: z.string().min(1).max(64),
      dims: DimsSchema,
      tags: z.array(z.string().min(1).max(64)).max(32),
      thumbnail: SourceFileSchema.nullable().default(null),
      files: z.array(SourceFileSchema).min(1),
    }),
  ).min(1).max(2000),
});
export type AssetPackSource = z.infer<typeof AssetPackSourceSchema>;

export const AssetPackManifestSchema = z.strictObject({
  schema: z.literal(ASSET_PACK_SCHEMA_ID),
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  title: z.string().min(1).max(120),
  author: z.string().min(1).max(120),
  license: z.string().min(1).max(120),
  lane: z.enum(["browser", "carla-native"]),
  entries: z.array(z.strictObject({
    id: z.string().min(1).max(128),
    label: z.string().min(1).max(120),
    class: z.string().min(1).max(64),
    dims: DimsSchema,
    tags: z.array(z.string().min(1).max(64)).max(32),
    thumbnail: ManifestFileSchema.nullable(),
    files: z.array(ManifestFileSchema).min(1),
  })).max(2000),
  blobs: z.record(Sha256Schema, z.strictObject({
    size: z.number().int().positive(),
    mediaType: z.string().min(1).max(120),
  })),
});
export type AssetPackManifest = z.infer<typeof AssetPackManifestSchema>;

export async function buildAssetPack(input: {
  configPath: string;
  outDir: string;
}): Promise<AssetPackManifest> {
  const configPath = path.resolve(input.configPath);
  const configDir = path.dirname(configPath);
  const source = AssetPackSourceSchema.parse(JSON.parse(await readFile(configPath, "utf8")));
  const entryIds = new Set<string>();
  const logicalPaths = new Set<string>();
  const blobs: AssetPackManifest["blobs"] = {};

  await mkdir(input.outDir, { recursive: true });
  const entries = [] as AssetPackManifest["entries"];
  for (const sourceEntry of source.entries) {
    if (entryIds.has(sourceEntry.id)) throw new Error(`duplicate entry id: ${sourceEntry.id}`);
    entryIds.add(sourceEntry.id);

    const packFile = async (file: z.infer<typeof SourceFileSchema>) => {
      if (logicalPaths.has(file.path)) throw new Error(`duplicate pack path: ${file.path}`);
      logicalPaths.add(file.path);
      const sourcePath = path.resolve(configDir, file.source);
      const bytes = await readFile(sourcePath);
      if (bytes.byteLength === 0) throw new Error(`pack file is empty: ${file.source}`);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const existing = blobs[sha256];
      if (existing && (existing.size !== bytes.byteLength || existing.mediaType !== file.mediaType)) {
        throw new Error(`blob metadata disagrees for sha256 ${sha256}`);
      }
      blobs[sha256] = { size: bytes.byteLength, mediaType: file.mediaType };
      const destination = path.resolve(input.outDir, ...file.path.split("/"));
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(sourcePath, destination);
      return { path: file.path, sha256, size: bytes.byteLength, mediaType: file.mediaType };
    };

    entries.push({
      id: sourceEntry.id,
      label: sourceEntry.label,
      class: sourceEntry.class,
      dims: sourceEntry.dims,
      tags: sourceEntry.tags,
      thumbnail: sourceEntry.thumbnail ? await packFile(sourceEntry.thumbnail) : null,
      files: await Promise.all(sourceEntry.files.map(packFile)),
    });
  }

  const manifest = AssetPackManifestSchema.parse({
    schema: ASSET_PACK_SCHEMA_ID,
    id: source.id,
    version: source.version,
    title: source.title,
    author: source.author,
    license: source.license,
    lane: source.lane,
    entries,
    blobs,
  });
  await writeFile(path.join(input.outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
