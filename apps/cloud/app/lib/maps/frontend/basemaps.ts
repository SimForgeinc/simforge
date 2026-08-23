/** Available basemap style definitions for MapLibre GL. */
export const BASEMAPS = [
  {
    id: "dark",
    label: "Dark",
    url: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
  },
  {
    id: "light",
    label: "Light",
    url: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
  },
  {
    id: "voyager",
    label: "Voyager",
    url: "https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json",
  },
] as const;

/** Union of valid basemap identifiers. */
export type BasemapId = (typeof BASEMAPS)[number]["id"];
/** Default basemap shown on initial map render. */
export const DEFAULT_BASEMAP: BasemapId = "dark";
