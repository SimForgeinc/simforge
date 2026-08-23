import { extractOpenScenarioExecutionPlan } from "@simforge/openscenario/execution-plan";
import { playbackBundleFromReplay, type PlaybackBundle } from "@simforge/playback";
import { getExecutionPackageMembersClient } from "@/app/lib/uniscenario/execution-package-client";
import { listOpenScenarioExports } from "./api";

export type BrowserCaptureSource =
  | {
      kind: "execution-package";
      bundle: PlaybackBundle;
      executionPackageId: string;
      executionPackageSha256: string;
      xoscSha256: string;
    }
  | {
      kind: "live-editor";
      bundle: PlaybackBundle;
    };

/**
 * Prefer immutable package bytes whenever the frozen revision already has a completed package.
 * A malformed or digest-invalid package is an error, never a reason to silently render mutable editor state.
 */
export async function resolveBrowserCaptureSource(input: {
  revisionId: string;
  liveBundle: PlaybackBundle;
  signal?: AbortSignal;
}): Promise<BrowserCaptureSource> {
  const exports = await listOpenScenarioExports(input.revisionId, input.signal);
  const succeeded = exports.find((candidate) => candidate.status === "succeeded" && candidate.executionPackageId);
  if (!succeeded?.executionPackageId) {
    return { kind: "live-editor", bundle: input.liveBundle };
  }

  const members = await getExecutionPackageMembersClient(succeeded.executionPackageId, input.signal);
  const xosc = members.find((member) => member.role === "xosc");
  const xodr = members.find((member) => member.role === "map-xodr");
  const manifest = members.find((member) => member.role === "execution-manifest");
  if (!xosc || !xodr || !manifest) {
    throw new Error("The execution package is missing its XOSC, XODR or execution manifest member.");
  }
  const replay = extractOpenScenarioExecutionPlan(new TextDecoder().decode(xosc.bytes), {
    sourceSha256: xosc.sha256,
  });
  const bundle = playbackBundleFromReplay(replay, {
    mapId: replay.mapId,
    engineGraphDigest: xodr.sha256,
  });
  return {
    kind: "execution-package",
    bundle,
    executionPackageId: succeeded.executionPackageId,
    executionPackageSha256: manifest.sha256,
    xoscSha256: xosc.sha256,
  };
}

export function browserCaptureSourceProvenance(source: BrowserCaptureSource) {
  if (source.kind === "live-editor") return { kind: "live-editor" as const };
  return {
    kind: "execution-package" as const,
    executionPackageId: source.executionPackageId,
    executionPackageSha256: source.executionPackageSha256,
    xoscSha256: source.xoscSha256,
  };
}
