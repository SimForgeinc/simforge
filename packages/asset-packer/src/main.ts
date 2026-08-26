import { buildAssetPack } from "./index.js";

function usage(): string {
  return "Usage: simforge-asset-pack build --config <pack-source.json> --out <directory>";
}

export async function main(argv: string[]): Promise<void> {
  const [command, ...args] = argv;
  if (command !== "build") throw new Error(usage());
  let configPath: string | undefined;
  let outDir: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--config") configPath = args[++index];
    else if (argument === "--out") outDir = args[++index];
    else throw new Error(`unknown argument: ${argument}\n${usage()}`);
  }
  if (!configPath || !outDir) throw new Error(usage());

  const manifest = await buildAssetPack({ configPath, outDir });
  process.stdout.write(`${JSON.stringify({
    schema: manifest.schema,
    id: manifest.id,
    version: manifest.version,
    entries: manifest.entries.length,
    blobs: Object.keys(manifest.blobs).length,
    outDir,
  })}\n`);
}
