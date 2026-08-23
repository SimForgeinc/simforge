"use client";

import { DatabaseZap } from "lucide-react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ProfileMapPreparation } from "@/app/components/ProfileMapPreparation";
import { SkyCloudBackdrop } from "@/app/components/SkyCloudBackdrop";
import { useSetPageTitle } from "@/app/components/TopBarSlot";
import { Button } from "@/app/components/ui/button";
import {
  readRenderingPreference,
  saveRenderingPreference,
  type RenderingPreference,
} from "@/app/components/city-viewer/rendering-preference";
import { QualityChooser } from "@/app/dashboard/uniscenario/editor/states/EditorStatePanels";
import { listMapOptions } from "@/app/dashboard/uniscenario/list/api";
import type { UniScenarioMapOption } from "@/app/dashboard/uniscenario/list/document-map-groups";
import { clearMapAssetCache } from "@/app/lib/maps/frontend/map-asset-cache";

type Preparation = {
  profile: RenderingPreference;
  redownload?: boolean;
};

const PROFILE_LABELS: Record<RenderingPreference, string> = {
  "roads-only": "Roads Only",
  "ultra-low-3d": "Low",
  minimal: "Balanced",
  high: "High",
};

const RenderingBenchmarkCard = dynamic(
  () =>
    import("@/app/dashboard/uniscenario/editor/regions/slots/RenderingBenchmark").then(
      (module) => module.RenderingBenchmarkCard,
    ),
  { ssr: false },
);

export function RenderSettingsPageClient() {
  useSetPageTitle("Render Settings");
  const router = useRouter();
  const [currentProfile, setCurrentProfile] =
    useState<RenderingPreference | null>(null);
  const [preparation, setPreparation] = useState<Preparation | null>(null);
  const [pendingProfile, setPendingProfile] =
    useState<RenderingPreference | null>(null);
  const [confirmRedownload, setConfirmRedownload] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [benchmarkTarget, setBenchmarkTarget] =
    useState<UniScenarioMapOption | null>(null);
  const [benchmarkCatalogReady, setBenchmarkCatalogReady] = useState(false);

  useEffect(() => setCurrentProfile(readRenderingPreference()), []);

  useEffect(() => {
    const controller = new AbortController();
    void listMapOptions(controller.signal)
      .then((maps) => {
        if (controller.signal.aborted) return;
        setBenchmarkTarget(
          maps.find((map) => Boolean(map.browserManifestUrl)) ?? null,
        );
        setBenchmarkCatalogReady(true);
      })
      .catch(() => {
        if (!controller.signal.aborted) setBenchmarkCatalogReady(true);
      });
    return () => controller.abort();
  }, []);

  const beginPreparation = (
    profile: RenderingPreference,
    redownload = false,
  ) => {
    saveRenderingPreference(profile);
    setCurrentProfile(profile);
    setPendingProfile(null);
    setConfirmRedownload(false);
    setPreparation({ profile, redownload });
  };

  const choose = (profile: RenderingPreference) => {
    if (currentProfile && currentProfile !== profile) {
      setPendingProfile(profile);
      return;
    }
    beginPreparation(profile);
  };

  const clearThenPrepare = async (profile: RenderingPreference) => {
    setClearing(true);
    try {
      await clearMapAssetCache();
      beginPreparation(profile, true);
    } finally {
      setClearing(false);
    }
  };

  const finish = () => router.push("/dashboard/map-assets");

  return (
    <div className="relative h-full min-h-0 overflow-hidden text-white">
      <SkyCloudBackdrop className="absolute" />
      <div className="relative z-10 h-full min-h-0 overflow-y-auto">
        {preparation ? (
          <ProfileMapPreparation
            profile={preparation.profile}
            redownload={preparation.redownload}
            onContinue={finish}
            onSkip={finish}
          />
        ) : (
          <QualityChooser
            onChoose={choose}
            titleId="render-settings-title"
            descriptionId="render-settings-description"
            benchmark={
              benchmarkTarget?.browserManifestUrl ? (
                <RenderingBenchmarkCard
                  manifestUrl={benchmarkTarget.browserManifestUrl}
                  mapLabel={benchmarkTarget.label}
                  currentQuality={currentProfile ?? "minimal"}
                  onApply={choose}
                />
              ) : (
                <div
                  className="mx-auto mt-6 w-full max-w-4xl px-6 py-5 text-center"
                  data-testid="rendering-benchmark-placeholder"
                  data-visual-treatment="flat"
                >
                  <p className="font-meta text-[10px] font-bold uppercase tracking-[0.18em] text-[#E8E044]">
                    Benchmark
                  </p>
                  <p className="mt-1 text-lg font-semibold text-white">
                    {benchmarkCatalogReady
                      ? "Benchmark unavailable"
                      : "Preparing benchmark…"}
                  </p>
                  <p className="mt-1 text-xs text-white/45">
                    {benchmarkCatalogReady
                      ? "Choose a rendering mode below."
                      : "Selecting a test map automatically."}
                  </p>
                </div>
              )
            }
            footer={
              currentProfile ? (
                <div className="flex flex-col items-center gap-2">
                  <Button
                    className="h-10 rounded-full border-white/15 bg-transparent px-5 text-xs text-white/65 hover:bg-white/5 hover:text-white"
                    onClick={() => setConfirmRedownload(true)}
                    type="button"
                    variant="outline"
                  >
                    <DatabaseZap className="size-4" aria-hidden="true" />
                    Delete cache and re-download{" "}
                    {PROFILE_LABELS[currentProfile]}
                  </Button>
                  <p className="text-center text-[11px] text-white/35">
                    Current setting: {PROFILE_LABELS[currentProfile]}
                  </p>
                </div>
              ) : null
            }
          />
        )}
      </div>

      {pendingProfile ? (
        <ConfirmationPanel
          title={`Switch to ${PROFILE_LABELS[pendingProfile]}?`}
          detail="You can keep the shared cache and download only missing files, or delete it first for a clean download."
          busy={clearing}
          primaryLabel="Delete cache and continue"
          secondaryLabel="Keep cache and continue"
          onCancel={() => setPendingProfile(null)}
          onPrimary={() => void clearThenPrepare(pendingProfile)}
          onSecondary={() => beginPreparation(pendingProfile)}
        />
      ) : null}

      {confirmRedownload && currentProfile ? (
        <ConfirmationPanel
          title="Delete the complete map cache?"
          detail={`All cached map assets will be removed, then the ${PROFILE_LABELS[currentProfile]} library will be downloaded again.`}
          busy={clearing}
          primaryLabel="Delete and re-download"
          onCancel={() => setConfirmRedownload(false)}
          onPrimary={() => void clearThenPrepare(currentProfile)}
        />
      ) : null}
    </div>
  );
}

function ConfirmationPanel({
  title,
  detail,
  busy,
  primaryLabel,
  secondaryLabel,
  onPrimary,
  onSecondary,
  onCancel,
}: {
  title: string;
  detail: string;
  busy: boolean;
  primaryLabel: string;
  secondaryLabel?: string;
  onPrimary: () => void;
  onSecondary?: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="absolute inset-0 z-30 grid place-items-center bg-black/55 p-5 backdrop-blur-xl"
      role="dialog"
      aria-modal="true"
      aria-labelledby="cache-confirmation-title"
    >
      <div className="w-full max-w-md rounded-[24px] border border-white/10 bg-[#101010]/95 p-6 shadow-2xl">
        <h2 id="cache-confirmation-title" className="text-xl font-semibold">
          {title}
        </h2>
        <p className="mt-2 text-sm leading-6 text-white/50">{detail}</p>
        <div className="mt-6 flex flex-col gap-2">
          <Button
            className="rounded-full bg-[#E8E044] text-black hover:bg-[#f1ea55]"
            disabled={busy}
            onClick={onPrimary}
          >
            {busy ? "Clearing cache…" : primaryLabel}
          </Button>
          {secondaryLabel && onSecondary ? (
            <Button
              className="rounded-full border-white/15 bg-transparent text-white hover:bg-white/5"
              disabled={busy}
              onClick={onSecondary}
              variant="outline"
            >
              {secondaryLabel}
            </Button>
          ) : null}
          <Button
            className="rounded-full text-white/50 hover:bg-transparent hover:text-white"
            disabled={busy}
            onClick={onCancel}
            variant="ghost"
          >
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}
