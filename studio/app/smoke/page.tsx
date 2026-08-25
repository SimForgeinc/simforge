import { AppTopBar } from "@/app/components/AppTopBar";
import { TopBarSlotProvider } from "@/app/components/TopBarSlot";

export default function SmokePage() {
  return (
    <TopBarSlotProvider>
      <div className="min-h-svh bg-background text-foreground">
        <AppTopBar />
        <main className="mx-auto max-w-5xl px-6 py-16">
          <p className="font-meta text-xs uppercase tracking-wide text-muted-foreground">Local platform</p>
          <h1 className="mt-3 font-display text-4xl font-semibold">SimForge chrome smoke surface</h1>
        </main>
      </div>
    </TopBarSlotProvider>
  );
}
