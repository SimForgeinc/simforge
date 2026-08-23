import { connection } from "next/server";
import { listUniScenarioMapDescriptors } from "@/app/lib/uniscenario/document-store";
import { requireUniScenarioContext, uniScenarioJsonWithEtag } from "@/app/lib/uniscenario/http";

export async function GET(request: Request) {
  await connection();
  const auth = await requireUniScenarioContext();
  if (auth.response) return auth.response;
  // Published map metadata is shared across every authenticated workspace. Browser assets and
  // previews use stable authenticated routes; those routes perform short-lived signing only after
  // their own authorization check.
  //
  // Revalidated rather than `no-store` (§2.5): every URL on the descriptor —
  // `browserManifestUrl`, `topologyArtifactUrl`, `derivedTopologyUrl`,
  // `signalsArtifactUrl` — is a same-origin path under `browserAssetRootUrl`,
  // not a presigned URL, so nothing here expires out from under a cached copy.
  // The editor reads this on every boot and the body rarely changes.
  return await uniScenarioJsonWithEtag(request, {
    maps: await listUniScenarioMapDescriptors(auth.context),
  });
}
