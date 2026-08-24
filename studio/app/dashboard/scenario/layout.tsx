import type { ReactNode } from "react";

import { ScenarioWorkspaceStatusProvider } from "./editor/status";

// This segment owns long-lived client state (the shared 3D world and status
// provider), so it cannot participate in Next.js instant-navigation prerenders.
export const instant = false;

/**
 * Route-level mount for the workspace status stream — manifest items 166-170.
 *
 * ## Why this moved up from the editor client
 *
 * `useScenarioWorkspaceStatus` and `useScenarioNotification` publish into a store, so a publisher
 * is heard from anywhere. But nothing is *rendered* unless the provider is mounted above it, and it used
 * to be mounted inside `ScenarioEditorClient` — which meant the dataset index and the review queue
 * had no notification dock and no boot gate at all. A page there could publish a blocking error and the
 * user would see an ordinary, apparently-working screen.
 *
 * That is the failure mode the provider's own docblock warns about: a surface that publishes a status
 * with no provider mounted looks exactly like a surface that publishes nothing. Hoisting it to the
 * segment root makes the guarantee structural rather than per-page — every route under
 * `dashboard/scenario/` gets the renderers, including ones nobody has written yet.
 *
 * ## Mount it here and nowhere below
 *
 * The dock and the boot gate are `fixed` overlays at `z-[70]` and `z-[60]`. A second provider in the
 * subtree does not nest, it *stacks*: two docks at identical coordinates reading the same store, so
 * every notification paints twice with doubled opacity on translucent surfaces, and the boot gate
 * doubles its backdrop. It reads as a styling bug and it is a mounting bug. `ScenarioEditorClient`
 * lost its own mount in the same commit for exactly this reason — do not re-add one.
 *
 * This stays a server component. It renders a client provider, which is fine, and keeps the segment
 * from being pulled wholesale into the client bundle.
 */
export default function ScenarioLayout({ children }: { children: ReactNode }) {
  return <ScenarioWorkspaceStatusProvider>{children}</ScenarioWorkspaceStatusProvider>;
}
