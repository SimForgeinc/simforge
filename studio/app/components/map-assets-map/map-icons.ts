import type { Map as MapLibreMap } from "maplibre-gl";
import type { MapOverlayLayerId } from "@simforge/studio-shared";
import type { RoadNetworkFeatureTypeId } from "@/app/lib/maps/frontend/road-network-feature-types";

// ---------------------------------------------------------------------------
// Icon assets
//
// POI glyphs are monochrome Maki paths (https://github.com/mapbox/maki, CC0),
// inlined as `d` attributes and rendered white so they read on top of the
// colored category chip (the existing circle layer). Sign icons are authentic
// MUTCD-style shapes authored here because Maki has no traffic-sign set.
//
// Icons are rasterized from SVG → canvas → ImageData and registered with
// `map.addImage(..., { pixelRatio })` at load. They are re-registered lazily
// via `styleimagemissing` because a basemap style swap wipes added images.
// ---------------------------------------------------------------------------

/** White POI glyphs, keyed by icon id. Values are Maki path `d` data (15×15). */
const GLYPH_PATHS: Record<string, string> = {
  "poi-bus":
    "M2 3C2 1.9 2.9 1 4 1H11C12.1 1 13 1.9 13 3V11C13 12 12 12 12 12V13C12 13.55 11.55 14 11 14C10.45 14 10 13.55 10 13V12H5V13C5 13.55 4.55 14 4 14C3.45 14 3 13.55 3 13V12C2 12 2 11 2 11V3ZM3.5 4C3.22 4 3 4.22 3 4.5V7.5C3 7.78 3.22 8 3.5 8H11.5C11.78 8 12 7.78 12 7.5V4.5C12 4.22 11.78 4 11.5 4H3.5ZM4 9C3.45 9 3 9.45 3 10C3 10.55 3.45 11 4 11C4.55 11 5 10.55 5 10C5 9.45 4.55 9 4 9ZM11 9C10.45 9 10 9.45 10 10C10 10.55 10.45 11 11 11C11.55 11 12 10.55 12 10C12 9.45 11.55 9 11 9ZM4 2.5C4 2.78 4.22 3 4.5 3H10.5C10.78 3 11 2.78 11 2.5C11 2.22 10.78 2 10.5 2H4.5C4.22 2 4 2.22 4 2.5Z",
  "poi-rail-metro":
    "M5.5,0c0,0-0.75,0-1,1L3,6.5V10c0,1,1,1,1,1h7c0,0,1,0,1-1V6.5L10.5,1c-0.2727-1-1-1-1-1H5.5z M6.5,1.5h2 c0,0,0.5357,0,0.75,1L10,6c0.2146,1.0017-1,1-1,1H6c0,0-1.2146,0.0017-1-1l0.75-3.5C5.9643,1.5,6.5,1.5,6.5,1.5z M5,8 c0.5523,0,1,0.4477,1,1s-0.4477,1-1,1S4,9.5523,4,9S4.4477,8,5,8z M6.75,8h1.5C8.3885,8,8.5,8.1115,8.5,8.25S8.3885,8.5,8.25,8.5 h-1.5C6.6115,8.5,6.5,8.3885,6.5,8.25S6.6115,8,6.75,8z M10,8c0.5523,0,1,0.4477,1,1s-0.4477,1-1,1S9,9.5523,9,9S9.4477,8,10,8z M4.125,12L3,15h1.5l0.375-1h5.25l0.375,1H12l-1.125-3h-1.5l0.375,1h-4.5l0.375-1H4.125z",
  "poi-fuel":
    "m14 6v5.5c0 .2761-.2239.5-.5.5s-.5-.2239-.5-.5v-2c0-.8284-.6716-1.5-1.5-1.5h-1.5v-6c0-.5523-.4477-1-1-1h-6c-.5523 0-1 .4477-1 1v11c0 .5523.4477 1 1 1h6c.5523 0 1-.4477 1-1v-4h1.5c.2761 0 .5.2239.5.5v2c0 .8284.6716 1.5 1.5 1.5s1.5-.6716 1.5-1.5v-6.5c0-.5523-.4477-1-1-1v-1.51c-.0054-.2722-.2277-.4901-.5-.49-.2816.0047-.5062.2367-.5015.5184.0002.0105.0007.0211.0015.0316v2.45c0 .5523.4477 1 1 1s1-.4477 1-1-.4477-1-1-1zm-5 .5c0 .2761-.2239.5-.5.5h-5c-.2761 0-.5-.2239-.5-.5v-3c0-.2761.2239-.5.5-.5h5c.2761 0 .5.2239.5.5z",
  "poi-restaurant":
    "M3.5,0l-1,5.5c-0.1464,0.805,1.7815,1.181,1.75,2L4,14c-0.0384,0.9993,1,1,1,1s1.0384-0.0007,1-1L5.75,7.5 c-0.0314-0.8176,1.7334-1.1808,1.75-2L6.5,0H6l0.25,4L5.5,4.5L5.25,0h-0.5L4.5,4.5L3.75,4L4,0H3.5z M12,0 c-0.7364,0-1.9642,0.6549-2.4551,1.6367C9.1358,2.3731,9,4.0182,9,5v2.5c0,0.8182,1.0909,1,1.5,1L10,14c-0.0905,0.9959,1,1,1,1 s1,0,1-1V0z",
  "poi-lodging":
    "M0.5,2.5C0.2,2.5,0,2.7,0,3v7.5v2C0,12.8,0.2,13,0.5,13S1,12.8,1,12.5V11h13v1.5 c0,0.3,0.2,0.5,0.5,0.5s0.5-0.2,0.5-0.5v-2c0-0.3-0.2-0.5-0.5-0.5H1V3C1,2.7,0.8,2.5,0.5,2.5z M3.5,3C2.7,3,2,3.7,2,4.5l0,0 C2,5.3,2.7,6,3.5,6l0,0C4.3,6,5,5.3,5,4.5l0,0C5,3.7,4.3,3,3.5,3L3.5,3z M7,4C5.5,4,5.5,5.5,5.5,5.5V7h-3C2.2,7,2,7.2,2,7.5v1 C2,8.8,2.2,9,2.5,9H6h9V6.5C15,4,12.5,4,12.5,4H7z",
  "poi-shop":
    "m13.33 5h-1.83l-.39-2.33c-.1601-.7182-.7017-1.2905-1.41-1.49-.3493-.1124-.7131-.173-1.08-.18h-2.24c-.3669.007-.7307.0676-1.08.18-.7083.1995-1.2499.7718-1.41 1.49l-.39 2.33h-1.83c-.2761-.0017-.5013.2208-.503.497-.0003.0519.0074.1035.023.153l1.88 6.3c.1964.6246.7753 1.0496 1.43 1.05h6c.651-.0047 1.2247-.4289 1.42-1.05l1.88-6.3c.0829-.2634-.0635-.5441-.3269-.627-.0463-.0146-.0945-.0223-.1431-.023zm-8.81 0 .36-2.17c.0807-.3625.3736-.6395.74-.7.2463-.0776.5019-.1213.76-.13h2.24c.2614.0078.5205.0515.77.13.3664.0605.6593.3375.74.7l.35 2.17h-6z",
  "poi-cart":
    "M 13.199219 1.5 C 13.199219 1.5 11.808806 1.4588 11.253906 2 C 10.720406 2.5202 10.5 2.9177 10.5 4 L 1.1992188 4 L 2.59375 8.8144531 C 2.59725 8.8217531 2.6036219 8.8287375 2.6074219 8.8359375 C 2.8418219 9.4932375 3.4545469 9.9666406 4.1855469 9.9941406 C 4.1885469 9.9954406 4.1992187 10 4.1992188 10 L 10.699219 10 L 10.699219 10.199219 C 10.699219 10.199219 10.7 10.500391 10.5 10.900391 C 10.3 11.300391 10.200391 11.5 9.4003906 11.5 L 2.9003906 11.5 C 1.9003906 11.5 1.9003906 13 2.9003906 13 L 4.0996094 13 L 4.1992188 13 L 9.0996094 13 L 9.1992188 13 L 9.3007812 13 C 10.500781 13 11.399219 12.299609 11.699219 11.599609 C 11.999219 10.899609 12 10.300781 12 10.300781 L 12 10 L 12 4 C 12 3.4764 12.228619 3 12.699219 3 L 13.25 3 C 13.6642 3 14 2.6642 14 2.25 C 14 1.8358 13.6642 1.5 13.25 1.5 L 13.199219 1.5 z M 9.1992188 13 C 8.5992188 13 8.1992188 13.4 8.1992188 14 C 8.1992188 14.6 8.5992187 15 9.1992188 15 C 9.7992187 15 10.199219 14.6 10.199219 14 C 10.199219 13.4 9.7992188 13 9.1992188 13 z M 4.1992188 13 C 3.5992188 13 3.1992188 13.4 3.1992188 14 C 3.1992188 14.6 3.5992187 15 4.1992188 15 C 4.7992188 15 5.1992188 14.6 5.1992188 14 C 5.1992188 13.4 4.7992187 13 4.1992188 13 z",
  "poi-hospital":
    "M7,1C6.4,1,6,1.4,6,2v4H2C1.4,6,1,6.4,1,7v1 c0,0.6,0.4,1,1,1h4v4c0,0.6,0.4,1,1,1h1c0.6,0,1-0.4,1-1V9h4c0.6,0,1-0.4,1-1V7c0-0.6-0.4-1-1-1H9V2c0-0.6-0.4-1-1-1H7z",
  "poi-school":
    "M5.542 3.647 3.106 3l.443-1.63a.505.505 0 0 1 .618-.352l1.46.392a.5.5 0 0 1 .355.613l-.44 1.624Zm-4.52 7.356a.496.496 0 0 1-.005-.276l1.819-6.726 2.435.647-1.819 6.726a.499.499 0 0 1-.143.237l-1.457 1.347a.152.152 0 0 1-.247-.066l-.583-1.889ZM10 5c-2.25 0-3-.75-3-3 2.25 0 3 .75 3 3Zm-1.4 7.984c-1.37.21-3.126-1.706-3.52-3.8L5.969 5.9c.399-.35.903-.533 1.419-.533a2.71 2.71 0 0 1 1.564.489.964.964 0 0 0 1.089-.01 2.438 2.438 0 0 1 1.46-.479c.77 0 1.643.489 2.05 1.201 1.536 2.696-1.194 6.709-3.144 6.417a.867.867 0 0 1-.255-.093 1.427 1.427 0 0 0-1.302 0 .866.866 0 0 1-.25.092Z",
  "poi-airport":
    "M15,6.8182L15,8.5l-6.5-1 l-0.3182,4.7727L11,14v1l-3.5-0.6818L4,15v-1l2.8182-1.7273L6.5,7.5L0,8.5V6.8182L6.5,4.5v-3c0,0,0-1.5,1-1.5s1,1.5,1,1.5v2.8182 L15,6.8182z",
  "poi-parking":
    "M4 2V13H6V9H8.5C10.433 9 12 7.433 12 5.5C12 3.567 10.433 2 8.5 2H4ZM6 7V4H8.5C9.32843 4 10 4.67157 10 5.5C10 6.32843 9.32843 7 8.5 7H6Z",
  "poi-building":
    "M3,2v11h5v-3h3v3h1V2H3z M7,12H4v-2h3V12z M7,9H4V7h3V9z M7,6H4V4h3V6z M11,9H8V7h3V9z M11,6H8V4h3V6z",
};

/** Authentic full-color sign icons, keyed by icon id (24×24 viewBox). */
const SIGN_SVGS: Record<string, string> = {
  "sign-stop":
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><polygon points="7,0.5 17,0.5 23.5,7 23.5,17 17,23.5 7,23.5 0.5,17 0.5,7" fill="#c8102e" stroke="#ffffff" stroke-width="1.4"/><text x="12" y="14.4" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-weight="700" font-size="6" fill="#ffffff">STOP</text></svg>',
  "sign-yield":
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><polygon points="12,22 1.5,3.5 22.5,3.5" fill="#ffffff" stroke="#d4282a" stroke-width="3.2" stroke-linejoin="round"/></svg>',
  "sign-warning":
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><polygon points="12,1 23,12 12,23 1,12" fill="#febd11" stroke="#1a1a1a" stroke-width="1.6" stroke-linejoin="round"/><rect x="11" y="6" width="2" height="7" rx="1" fill="#1a1a1a"/><circle cx="12" cy="17" r="1.4" fill="#1a1a1a"/></svg>',
  "sign-speed":
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#ffffff" stroke="#d4282a" stroke-width="3"/></svg>',
  // White speed-limit plate — a bordered rounded rectangle that `icon-text-fit`
  // grows around the number (drawn as MapLibre text). Registered with stretch
  // metadata (see SIGN_STRETCH) so only the middle stretches and the rounded
  // corners stay crisp. Border colour distinguishes the source at a glance so
  // the two overlays are easy to cross-check: black = in-house/XODR, blue =
  // Overture.
  "sign-speed-xodr":
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect x="1.4" y="1.4" width="21.2" height="21.2" rx="5" fill="#ffffff" stroke="#111111" stroke-width="1.8"/></svg>',
  "sign-speed-overture":
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect x="1.4" y="1.4" width="21.2" height="21.2" rx="5" fill="#ffffff" stroke="#2563eb" stroke-width="2"/></svg>',
};

// Stretch metadata for the speed-limit plates (image space = 24 viewBox × RENDER_SCALE).
// The straight edges between the rounded corners stretch; the corners stay fixed.
const SPEED_SIGN_STRETCH = {
  stretchX: [[14, 34]] as [number, number][],
  stretchY: [[14, 34]] as [number, number][],
  content: [8, 8, 40, 40] as [number, number, number, number],
};
const SIGN_STRETCH: Record<string, typeof SPEED_SIGN_STRETCH> = {
  "sign-speed-xodr": SPEED_SIGN_STRETCH,
  "sign-speed-overture": SPEED_SIGN_STRETCH,
};

/** US speed-limit-sign icon ids (see SIGN_SVGS). */
export const SPEED_SIGN_XODR_ICON = "sign-speed-xodr";
export const SPEED_SIGN_OVERTURE_ICON = "sign-speed-overture";

// ---------------------------------------------------------------------------
// Polyline "chip" icons
//
// Linear assets (parking/bike/sidewalk lanes, sidewalks, crosswalks) carry no
// single label point, so a POI-style circle+glyph can't be stamped on them.
// Instead we bake a colored disc + white glyph into one icon and place it ALONG
// the line via `symbol-placement: line` (or once at the center for short
// features). Disc colors follow conventional signage so the glyph reads at a
// glance regardless of the underlying line color.
// ---------------------------------------------------------------------------

function chipSvg(fill: string, inner: string): string {
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' +
    `<circle cx="12" cy="12" r="10.4" fill="${fill}" stroke="#ffffff" stroke-width="1.6"/>` +
    inner +
    "</svg>"
  );
}

/** Round disc + white glyph icons for polyline assets, keyed by icon id. */
const CHIP_SVGS: Record<string, string> = {
  // Blue "P" — the universal parking glyph.
  "chip-parking": chipSvg(
    "#2563eb",
    '<text x="12" y="16.8" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-weight="700" font-size="14" fill="#ffffff">P</text>',
  ),
  // Green bicycle — two wheels, a frame triangle, and a seat dot.
  "chip-bike": chipSvg(
    "#16a34a",
    '<g fill="none" stroke="#ffffff" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.2" cy="15" r="3"/><circle cx="16.8" cy="15" r="3"/><path d="M7.2 15 L11 15 L13.7 9.6 L10.3 9.6 M13.7 9.6 L16.8 15 M11 15 L13.4 10.2"/></g><circle cx="13.9" cy="8.4" r="0.9" fill="#ffffff"/>',
  ),
  // Walking pedestrian stick figure.
  "chip-pedestrian": chipSvg(
    "#0891b2",
    '<circle cx="12" cy="6.4" r="1.8" fill="#ffffff"/><g fill="none" stroke="#ffffff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8.6 L12 13.2"/><path d="M12 13.2 L9.7 17.6 M12 13.2 L14.3 17.6"/><path d="M12 10.2 L9.6 11.7 M12 10.2 L14.4 11.2"/></g>',
  ),
  // Zebra stripes — the universal crosswalk marking.
  "chip-crosswalk": chipSvg(
    "#0f3d5c",
    '<g fill="#ffffff"><rect x="7.2" y="7.7" width="1.5" height="8.6" rx="0.6"/><rect x="9.9" y="7.7" width="1.5" height="8.6" rx="0.6"/><rect x="12.6" y="7.7" width="1.5" height="8.6" rx="0.6"/><rect x="15.3" y="7.7" width="1.5" height="8.6" rx="0.6"/></g>',
  ),
};

// ---------------------------------------------------------------------------
// Lane direction arrows
//
// Small white triangles with a dark outline, stamped along a lane to show
// travel direction. They replace the old `>`/`<` text glyphs, which floated
// illegibly on the translucent filled-lane wash. White-on-dark-outline reads on
// any lane color (driving / biking / sidewalk) and on the gold selection wash.
// Placed along the centerline via `symbol-placement: line`, so a single
// right-pointing triangle aligns with the line direction (= Forward); Backward
// rotates it 180°, Bidirectional uses the double-headed variant.
// ---------------------------------------------------------------------------
const ARROW_SVGS: Record<string, string> = {
  "lane-dir-arrow":
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M6 5 L19 12 L6 19 Z" fill="#ffffff" stroke="#10243a" stroke-width="2.2" stroke-linejoin="round"/></svg>',
  "lane-dir-arrow-bi":
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M9.5 6 L2.5 12 L9.5 18 Z M14.5 6 L21.5 12 L14.5 18 Z" fill="#ffffff" stroke="#10243a" stroke-width="2.2" stroke-linejoin="round"/></svg>',
};

/** Icon ids for the lane direction-arrow triangles. */
export const LANE_DIR_ARROW_ICON = "lane-dir-arrow";
export const LANE_DIR_ARROW_BI_ICON = "lane-dir-arrow-bi";

/** Enrichment overlay layer → POI glyph icon id. */
export const ENRICHMENT_GLYPH_ICON: Partial<Record<MapOverlayLayerId, string>> = {
  bus_stops: "poi-bus",
  transit_stop: "poi-rail-metro",
  gas_stations: "poi-fuel",
  restaurant: "poi-restaurant",
  hotel: "poi-lodging",
  retail: "poi-shop",
  shopping_mall: "poi-cart",
  hospitals: "poi-hospital",
  schools: "poi-school",
  airport: "poi-airport",
  parking_lots: "poi-parking",
  buildings: "poi-building",
};

/** Signal category → authentic sign icon id. */
export const SIGNAL_SIGN_ICON: Record<string, string> = {
  stop_sign: "sign-stop",
  yield_sign: "sign-yield",
  warning_sign: "sign-warning",
  speed_limit_sign: "sign-speed",
};

/** Road-network lane feature type → polyline chip icon id. */
export const LANE_CHIP_ICON: Partial<Record<RoadNetworkFeatureTypeId, string>> = {
  lanes_parking: "chip-parking",
  lanes_biking: "chip-bike",
  lanes_sidewalk: "chip-pedestrian",
};

/** Enrichment LineString overlay layer → polyline chip icon id. */
export const ENRICHMENT_LINE_CHIP_ICON: Partial<Record<MapOverlayLayerId, string>> = {
  sidewalks: "chip-pedestrian",
  crosswalks: "chip-crosswalk",
};

/** Chip icon for the XODR crosswalk polygons drawn in the signal overlay. */
export const CROSSWALK_CHIP_ICON = "chip-crosswalk";

const GLYPH_LOGICAL_PX = 18;
const SIGN_LOGICAL_PX = 24;
const CHIP_LOGICAL_PX = 22;
const ARROW_LOGICAL_PX = 18;
const RENDER_SCALE = 2;

function glyphSvg(d: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 15 15" fill="#ffffff"><path d="${d}"/></svg>`;
}

/** Path `d` for an enrichment layer's white glyph, for inline legend rendering. */
export function enrichmentGlyphPath(layerId: MapOverlayLayerId): string | undefined {
  const iconId = ENRICHMENT_GLYPH_ICON[layerId];
  return iconId ? GLYPH_PATHS[iconId] : undefined;
}

function rasterize(svg: string, px: number): Promise<ImageData> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = px;
      canvas.height = px;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("2d context unavailable"));
        return;
      }
      ctx.clearRect(0, 0, px, px);
      ctx.drawImage(img, 0, 0, px, px);
      resolve(ctx.getImageData(0, 0, px, px));
    };
    img.onerror = () => reject(new Error("SVG icon failed to load"));
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
}

type IconStretch = {
  stretchX?: [number, number][];
  stretchY?: [number, number][];
  content?: [number, number, number, number];
};

async function addIcon(
  map: MapLibreMap,
  id: string,
  svg: string,
  logicalPx: number,
  stretch?: IconStretch,
): Promise<void> {
  if (map.hasImage(id)) return;
  try {
    const data = await rasterize(svg, Math.round(logicalPx * RENDER_SCALE));
    // Re-check after the async gap — a concurrent caller may have added it.
    if (!map.hasImage(id)) map.addImage(id, data, { pixelRatio: RENDER_SCALE, ...(stretch ?? {}) });
  } catch {
    // A missing icon simply renders nothing; never block map load on it.
  }
}

function addAll(map: MapLibreMap): void {
  for (const [id, d] of Object.entries(GLYPH_PATHS)) void addIcon(map, id, glyphSvg(d), GLYPH_LOGICAL_PX);
  for (const [id, svg] of Object.entries(SIGN_SVGS)) void addIcon(map, id, svg, SIGN_LOGICAL_PX, SIGN_STRETCH[id]);
  for (const [id, svg] of Object.entries(CHIP_SVGS)) void addIcon(map, id, svg, CHIP_LOGICAL_PX);
  for (const [id, svg] of Object.entries(ARROW_SVGS)) void addIcon(map, id, svg, ARROW_LOGICAL_PX);
}

/**
 * Register all enrichment glyphs and sign icons on the map. Idempotent, and
 * re-registers on demand after basemap style swaps (which clear added images).
 */
export function registerMapIcons(map: MapLibreMap): void {
  addAll(map);
  const hooked = map as unknown as { __sfMapIconsHooked?: boolean };
  if (hooked.__sfMapIconsHooked) return;
  hooked.__sfMapIconsHooked = true;
  map.on("styleimagemissing", (event: { id: string }) => {
    const { id } = event;
    if (id in GLYPH_PATHS) void addIcon(map, id, glyphSvg(GLYPH_PATHS[id]!), GLYPH_LOGICAL_PX);
    else if (id in SIGN_SVGS) void addIcon(map, id, SIGN_SVGS[id]!, SIGN_LOGICAL_PX);
    else if (id in CHIP_SVGS) void addIcon(map, id, CHIP_SVGS[id]!, CHIP_LOGICAL_PX);
    else if (id in ARROW_SVGS) void addIcon(map, id, ARROW_SVGS[id]!, ARROW_LOGICAL_PX);
  });
}
