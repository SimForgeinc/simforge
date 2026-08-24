"use client";

import Image from "next/image";
import Link from "next/link";
import { Map as MapIcon, MapPin, SquarePen } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/app/components/ui/button";
import type { ScenarioMapDescriptorDto } from "@/app/lib/scenario/contracts";

/**
 * Published map versions, for the Maps section of the asset library.
 *
 * The list is the map catalog the scenario editor itself reads, so it is fetched
 * from the same route the editor boots from rather than a second projection that
 * could disagree about which versions are usable. Server order (`label, id`) is
 * preserved: the catalog carries no publication timestamp, and re-sorting here
 * would only invent an order the editor's own picker does not share.
 */
export function MapList({
  reloadToken,
  onUpload,
}: {
  reloadToken: number;
  onUpload: () => void;
}) {
  const [maps, setMaps] = useState<ScenarioMapDescriptorDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const abort = new AbortController();
    setError(null);
    void (async () => {
      try {
        const response = await fetch("/api/uniscenario/maps", {
          cache: "no-store",
          signal: abort.signal,
        });
        if (!response.ok) {
          throw new Error(`The published map catalog could not be loaded (${response.status}).`);
        }
        const body = (await response.json()) as { maps: ScenarioMapDescriptorDto[] };
        setMaps(body.maps);
      } catch (reason) {
        if (abort.signal.aborted) return;
        setError(
          reason instanceof Error ? reason.message : "The published map catalog could not be loaded.",
        );
      }
    })();
    return () => abort.abort();
  }, [reloadToken]);

  if (error) {
    return (
      <p role="alert" className="rounded-lg border border-red-400/20 bg-red-400/5 px-4 py-3 text-sm text-red-200">
        {error}
      </p>
    );
  }

  if (maps === null) {
    return (
      <div className="grid min-h-80 place-items-center rounded-xl border border-dashed border-white/10 text-center">
        <p className="text-sm text-white/35">Loading published maps…</p>
      </div>
    );
  }

  if (maps.length === 0) {
    return (
      <div className="grid min-h-80 place-items-center rounded-xl border border-dashed border-white/10 px-6 text-center">
        <div className="max-w-md">
          <MapIcon className="mx-auto size-8 text-white/20" />
          <p className="mt-3 text-sm text-white/55">No maps are published yet.</p>
          <p className="mt-1 text-xs text-white/35">
            Upload an OpenDRIVE file and one GLB per layer — a file named <code className="font-mono">road.glb</code> is
            required — and the server builds the rest.
          </p>
          <Button type="button" onClick={onUpload} className="mt-5 bg-[#E8E044] text-black hover:bg-[#f3ec62]">
            Upload a map
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
      {maps.map((map) => (
        <article
          key={map.mapVersionId}
          className="group overflow-hidden rounded-xl border border-white/[0.08] bg-white/[0.025] transition-[border-color,background-color] hover:border-white/20 hover:bg-white/[0.045]"
        >
          <div className="relative aspect-[4/3] overflow-hidden bg-[radial-gradient(circle_at_50%_42%,#29313a,#101317_68%)]">
            {map.thumbnailUrl ? (
              <Image
                src={map.thumbnailUrl}
                alt=""
                fill
                sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, (max-width: 1536px) 25vw, 20vw"
                // The route redirects to immutable media; image optimization adds no value.
                unoptimized
                className="object-cover transition-transform duration-300 group-hover:scale-[1.025] motion-reduce:transition-none"
              />
            ) : (
              <div className="grid h-full place-items-center">
                <MapIcon className="size-7 text-white/15" />
              </div>
            )}
          </div>
          <div className="p-4">
            <h2 className="truncate text-sm font-semibold" title={map.label}>{map.label}</h2>
            <div className="mt-2 flex items-center gap-1.5 text-xs text-white/35">
              <MapPin className="size-3 shrink-0" aria-hidden="true" />
              <span className="truncate">{map.locality ?? "Locality not recorded"}</span>
            </div>
            <p className="mt-3 truncate font-mono text-[10px] text-white/30" title={map.mapVersionId}>
              {map.mapVersionId}
            </p>
            <Button
              asChild
              size="sm"
              variant="outline"
              className="mt-3 w-full border-white/10 bg-transparent"
            >
              <Link href="/dashboard/scenario" aria-label={`Author a scenario on ${map.label}`}>
                <SquarePen aria-hidden="true" />
                Author a scenario
              </Link>
            </Button>
          </div>
        </article>
      ))}
    </div>
  );
}
