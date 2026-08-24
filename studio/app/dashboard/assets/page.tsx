import { Suspense } from "react";
import { connection } from "next/server";
import { Skeleton } from "@/app/components/ui/skeleton";
import { listGalleryAssets } from "@/app/lib/asset-gallery/store";
import { requireAppContext } from "@/app/lib/db/app-context";
import { AssetGalleryClient } from "./AssetGalleryClient";
import { AssetGalleryGridSkeleton } from "./AssetGalleryGrid";
import { AssetsTabs } from "./AssetsTabs";

const GALLERY_PAGE_SIZE = 24;

/**
 * The per-request half of the page: the session, and the first page of the
 * public catalog it is allowed to see.
 *
 * Split behind its own boundary rather than awaited at the top of the route.
 * `connection()` and the session read cannot be prerendered, and nothing under
 * the same boundary as them prerenders either — with the awaits at the top, the
 * whole gallery sat below the dashboard's generic route spinner and this page's
 * own chrome never reached the shell. Now the shelf streams into a placeholder
 * shaped like the catalog it is about to become.
 */
async function GalleryShelf() {
  await connection();
  const context = await requireAppContext("/dashboard/assets");
  const initialPage = await listGalleryAssets({
    viewerUserId: context.userId,
    limit: GALLERY_PAGE_SIZE,
  });
  return <AssetGalleryClient initialPage={initialPage} />;
}

/** Header block and tile grid at their real sizes, so the swap does not reflow. */
function GalleryShelfFallback() {
  return (
    <>
      <div className="border-b border-border bg-background px-5 sm:px-8" aria-hidden="true">
        <div className="mx-auto max-w-[1500px] py-5">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="mt-2.5 h-8 w-56" />
          <Skeleton className="mt-3 h-4 w-full max-w-xl" />
          <Skeleton className="mt-5 h-9 w-40 rounded-md" />
        </div>
      </div>
      <div className="px-5 py-6 sm:px-8">
        <div className="mx-auto max-w-[1500px]">
          <AssetGalleryGridSkeleton />
        </div>
      </div>
    </>
  );
}

export default function AssetsPage() {
  return (
    <div className="min-h-full bg-background">
      <AssetsTabs />
      <Suspense fallback={<GalleryShelfFallback />}>
        <GalleryShelf />
      </Suspense>
    </div>
  );
}
