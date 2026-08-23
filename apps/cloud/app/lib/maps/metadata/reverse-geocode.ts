/**
 * Offline reverse geocoder: resolves a lat/lon to city, state, and country using
 * the GeoNames cities1000 dataset bundled as a static JSON file.
 *
 * The three JSON files (cities.json, admin1.json, countries.json) are pre-built
 * by scripts/build-geocoder-data.mjs and committed to the repository — no network
 * access is required at runtime.
 *
 * Data format (cities.json): [lat, lon, cityName, admin1Code, countryCode][]
 * Data format (admin1.json): { "US.CA": "California", ... }
 * Data format (countries.json): { "US": "United States", ... }
 *
 * Algorithm:
 *  1. Prefilter cities within ±BBOX_DEG degrees of the target (eliminates ~99% of rows).
 *  2. Haversine nearest-neighbor on remaining candidates.
 *  3. Reject result if nearest city is more than MAX_DIST_KM away (open ocean / polar).
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MapPlaceContext } from "@simcloud/shared";

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------

/** Initial bounding-box prefilter half-width in degrees (~222 km at equator). */
const BBOX_DEG = 2.0;

/** Maximum distance to accept a nearest-city result. Beyond this the coordinates
 *  are likely in open ocean or a polar region with no populated place. */
const MAX_DIST_KM = 150;

// ---------------------------------------------------------------------------
// Lazy-loaded data singletons
// ---------------------------------------------------------------------------

type CityRow = [number, number, string, string, string];
// [lat, lon, cityName, admin1Code, countryCode]

let _cities: CityRow[] | null = null;
let _admin1: Record<string, string> | null = null;
let _countries: Record<string, string> | null = null;

let _dataDir: string | null = null;

function dataDir(): string {
  if (_dataDir) return _dataDir;

  // Strategy: try process.cwd()-relative first (works for Next.js where
  // __dirname points into .next/server/ and the static files aren't there),
  // then fall back to the file's own directory (works for scripts run via tsx
  // from the monorepo root where cwd ≠ apps/web).
  const cwdCandidate = join(process.cwd(), "app", "lib", "maps", "metadata", "geocoder-data");
  if (existsSync(join(cwdCandidate, "cities.json"))) {
    _dataDir = cwdCandidate;
    return _dataDir;
  }

  // __dirname equivalent for ESM / tsx
  const thisDir = typeof __dirname !== "undefined"
    ? __dirname
    : dirname(fileURLToPath(import.meta.url));
  _dataDir = join(thisDir, "geocoder-data");
  return _dataDir;
}

function getCities(): CityRow[] {
  if (!_cities) {
    _cities = JSON.parse(
      readFileSync(join(dataDir(), "cities.json"), "utf8"),
    ) as CityRow[];
  }
  return _cities;
}

function getAdmin1(): Record<string, string> {
  if (!_admin1) {
    _admin1 = JSON.parse(
      readFileSync(join(dataDir(), "admin1.json"), "utf8"),
    ) as Record<string, string>;
  }
  return _admin1;
}

function getCountries(): Record<string, string> {
  if (!_countries) {
    _countries = JSON.parse(
      readFileSync(join(dataDir(), "countries.json"), "utf8"),
    ) as Record<string, string>;
  }
  return _countries;
}

// ---------------------------------------------------------------------------
// Haversine distance (km)
// ---------------------------------------------------------------------------

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Reverse geocode a WGS84 lat/lon to city, state, and country.
 *
 * Returns `undefined` if the nearest city is more than 150 km away (e.g. open
 * ocean or polar region) or if the data files cannot be read.
 */
export function reverseGeocodeCity(lat: number, lon: number): MapPlaceContext | undefined {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return undefined;

  try {
    const cities = getCities();
    const admin1Map = getAdmin1();
    const countriesMap = getCountries();

    // 1. Prefilter: bounding box
    const candidates = cities.filter(
      (c) => Math.abs(c[0] - lat) <= BBOX_DEG && Math.abs(c[1] - lon) <= BBOX_DEG,
    );

    if (candidates.length === 0) return undefined;

    // 2. Nearest-neighbor by Haversine
    let nearest: CityRow | null = null;
    let minDist = Infinity;
    for (const city of candidates) {
      const d = haversineKm(lat, lon, city[0], city[1]);
      if (d < minDist) {
        minDist = d;
        nearest = city;
      }
    }

    if (!nearest || minDist > MAX_DIST_KM) return undefined;

    const [, , cityName, admin1Code, countryCode] = nearest;

    // 3. Resolve state and country names
    const state = admin1Code ? admin1Map[`${countryCode}.${admin1Code}`] : undefined;
    const country = countriesMap[countryCode];

    return {
      city: cityName || undefined,
      state: state || undefined,
      country: country || undefined,
      country_code: countryCode || undefined,
      geocoder: "geonames-local",
    };
  } catch (err) {
    console.error("[reverse-geocode] Failed to load geocoder data:", err);
    return undefined;
  }
}
