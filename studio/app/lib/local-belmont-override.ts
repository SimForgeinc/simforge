/**
 * Env-gated dev override that serves 3D-asset paths from a local Belmont
 * dataset folder instead of S3. Refuses to load in deployed infrastructure.
 *
 * When `USE_LOCAL_BELMONT=1` is set locally, the 3D-asset route streams files
 * from `~/city-digital-twin/data/belmont/{...path}` regardless of
 * `mapAssetId`. The guard fires when the module loads inside Amplify Lambda,
 * Vercel, or a named SimForge shared environment. Local `next dev`, local
 * `next build`, and local `next start` keep these deployed-runtime env vars
 * unset, so the override remains available on a developer machine.
 */
import path from "node:path";
import os from "node:os";
import { promises as fs, createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";

const FLAG = "USE_LOCAL_BELMONT";
const ROOT_OVERRIDE = "LOCAL_BELMONT_ROOT";
const DEFAULT_ROOT = path.join(
  os.homedir(),
  "city-digital-twin",
  "data",
  "belmont",
);

function deployedRuntimeReason(): string | null {
  if (process.env.AWS_LAMBDA_FUNCTION_NAME) {
    return `AWS_LAMBDA_FUNCTION_NAME=${process.env.AWS_LAMBDA_FUNCTION_NAME}`;
  }
  if (process.env.VERCEL === "1" || process.env.VERCEL_ENV) {
    return `VERCEL=${process.env.VERCEL ?? ""} VERCEL_ENV=${process.env.VERCEL_ENV ?? ""}`.trim();
  }
  if (["dev", "staging", "prod"].includes(process.env.SIMFORGE_ENV ?? "")) {
    return `SIMFORGE_ENV=${process.env.SIMFORGE_ENV}`;
  }
  return null;
}

const deployedReason = deployedRuntimeReason();
if (process.env[FLAG] === "1" && deployedReason) {
  throw new Error(
    `${FLAG}=1 is not allowed in a deployed execution context ` +
      `(${deployedReason}). ` +
      `This dev override must never run in deployed environments.`,
  );
}

const CONTENT_TYPES: Record<string, string> = {
  ".json": "application/json",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".bin": "application/octet-stream",
  ".hdr": "image/vnd.radiance",
  ".ktx2": "image/ktx2",
};

let activationLogged = false;

export function isLocalBelmontEnabled(): boolean {
  return process.env[FLAG] === "1";
}

export function getLocalBelmontRoot(): string {
  return process.env[ROOT_OVERRIDE] ?? DEFAULT_ROOT;
}

export type ServeOptions = {
  root?: string;
  logger?: (message: string) => void;
};

export async function serveLocalBelmontFile(
  segments: string[],
  options: ServeOptions = {},
): Promise<NextResponse> {
  const root = options.root ?? getLocalBelmontRoot();
  const log = options.logger ?? console.log;

  if (!activationLogged) {
    activationLogged = true;
    log(`[CityViewer LOCAL OVERRIDE] Serving 3D assets from ${root}`);
  }

  // Reject any segment that could escape the root before resolving.
  for (const seg of segments) {
    if (
      !seg ||
      seg === "." ||
      seg === ".." ||
      seg.includes("/") ||
      seg.includes("\\") ||
      seg.includes("\0")
    ) {
      return new NextResponse("Not found", { status: 404 });
    }
  }

  // This path intentionally lives outside the deployment bundle: the override
  // is local-only and reads an operator-selected development directory.
  const normalizedRoot = path.resolve(/* turbopackIgnore: true */ root);
  const candidate = path.resolve(normalizedRoot, ...segments);
  if (
    candidate !== normalizedRoot &&
    !candidate.startsWith(normalizedRoot + path.sep)
  ) {
    return new NextResponse("Not found", { status: 404 });
  }

  let stat;
  try {
    stat = await fs.stat(candidate);
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }
  if (!stat.isFile()) {
    return new NextResponse("Not found", { status: 404 });
  }

  const ext = path.extname(candidate).toLowerCase();
  const contentType = CONTENT_TYPES[ext] ?? "application/octet-stream";

  const nodeStream = createReadStream(candidate);
  const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream;

  return new NextResponse(webStream, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(stat.size),
      "Cache-Control": "private, max-age=0, must-revalidate",
    },
  });
}
