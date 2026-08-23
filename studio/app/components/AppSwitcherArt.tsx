import Image from "next/image";

type AppSwitcherArtProps = {
  href: string;
  className?: string;
};

const APP_ART = {
  "/dashboard/map-assets": {
    name: "maps",
    src: "/app-switcher/maps-art-v1.png",
  },
  "/dashboard/assets": {
    name: "assets",
    src: "/app-switcher/assets.png",
  },
  "/dashboard/uniscenario": {
    name: "datasets",
    src: "/app-switcher/datasets-art-v1.png",
  },
  "/dashboard/dataset-export": {
    name: "exports",
    src: "/app-switcher/exports-art-v1.png",
  },
} as const;

export function AppSwitcherArt({ href, className }: AppSwitcherArtProps) {
  const art =
    APP_ART[href as keyof typeof APP_ART] ??
    APP_ART["/dashboard/dataset-export"];

  return (
    <Image
      alt=""
      aria-hidden="true"
      className={className}
      data-app-switcher-art={art.name}
      draggable={false}
      height={640}
      sizes="160px"
      src={art.src}
      width={640}
    />
  );
}
