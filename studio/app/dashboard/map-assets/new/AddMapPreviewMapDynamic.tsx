"use client";

import dynamic from "next/dynamic";

type Bbox = { min_lat: number; min_lng: number; max_lat: number; max_lng: number };

type Props = {
  geojson: object | null;
  bbox: Bbox | null;
  onThumbnailReady?: (blob: Blob) => void;
};

const AddMapPreviewMap = dynamic(() => import("./AddMapPreviewMap"), {
  ssr: false,
  loading: () => <div className="absolute inset-0 animate-pulse bg-muted" />,
});

export default function AddMapPreviewMapDynamic(props: Props) {
  return <AddMapPreviewMap {...props} />;
}
