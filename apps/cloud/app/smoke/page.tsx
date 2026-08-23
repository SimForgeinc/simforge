import { AppTopBar } from "@/app/components/AppTopBar";
import { TopBarSlotProvider } from "@/app/components/TopBarSlot";
import { LOCAL_SESSION, LOCAL_WORKSPACE_ID } from "@/app/lib/auth/session";

export default function SmokePage() {
  return (
    <TopBarSlotProvider>
      <div className="min-h-svh bg-background text-foreground">
        <AppTopBar
          accountEmail={LOCAL_SESSION.email!}
          creditsBalance={null}
          pendingCreditsCents={0}
          workspaces={[{ id: LOCAL_WORKSPACE_ID, type: "personal", name: "Local Workspace" }]}
          activeWorkspaceId={LOCAL_WORKSPACE_ID}
        />
        <main className="mx-auto max-w-5xl px-6 py-16">
          <p className="font-meta text-xs uppercase tracking-wide text-muted-foreground">Local platform</p>
          <h1 className="mt-3 font-display text-4xl font-semibold">SimCloud chrome smoke surface</h1>
        </main>
      </div>
    </TopBarSlotProvider>
  );
}
