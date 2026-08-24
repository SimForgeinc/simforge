/**
 * PROJ4 string parsing utilities.
 *
 * Re-exports from @simcloud/shared — the canonical implementation now lives
 * in the shared package for use by scene graph builders.
 */

export {
  parseProjOrigin,
  projProjectionType,
  utmZoneFromLonLat,
  parseDatum,
  parseHorizontalUnits,
  parseVerticalUnits,
} from "@simcloud/shared";
