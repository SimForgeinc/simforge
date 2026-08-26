import type { ReactNode } from "react";

// Drive owns a continuously advancing client-side world. Do not prerender a
// second route instance beside the interactive one: there must be one source,
// one control owner, and one truth-to-viewer bridge for the lifetime of Drive.
export const instant = false;

export default function DriveLayout({ children }: { children: ReactNode }) {
  return children;
}
