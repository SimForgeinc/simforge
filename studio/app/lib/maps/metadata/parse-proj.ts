/**
 * PROJ4 string parsing utilities.
 *
 * Re-exports from @simforge-oss/studio-shared — the canonical implementation now lives
 * in the shared package for use by scene graph builders.
 */

export {
  parseProjOrigin,
  projProjectionType,
  utmZoneFromLonLat,
  parseDatum,
  parseHorizontalUnits,
  parseVerticalUnits,
} from "@simforge-oss/studio-shared";
