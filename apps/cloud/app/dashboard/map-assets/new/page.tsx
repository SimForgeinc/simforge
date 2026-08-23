import { Suspense } from "react";
import { connection } from "next/server";
import { requireAppContext } from "@/app/lib/db/app-context";
import AddMapForm from "./AddMapForm";

/**
 * Authenticate for ourselves instead of inheriting the gate in
 * `app/dashboard/layout.tsx`. The form is a client component that reads nothing
 * server-side, so this is defence in depth rather than a fix.
 */
async function AddMapFormGate() {
  await connection();
  await requireAppContext("/dashboard/map-assets/new");
  return <AddMapForm />;
}

export default function AddMapPage() {
  // The heading strip stays outside the boundary so it prerenders into the shell.
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-11 shrink-0 items-center border-b border-border px-6">
        <h1 className="text-sm font-semibold">Add new map</h1>
      </div>
      <div className="flex min-h-0 flex-1">
        <Suspense fallback={null}>
          <AddMapFormGate />
        </Suspense>
      </div>
    </div>
  );
}
