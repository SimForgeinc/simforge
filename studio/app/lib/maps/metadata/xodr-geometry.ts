/**
 * XODR geometry sampling and coordinate transform utilities.
 *
 * Re-exports from @simcloud/shared — the canonical implementation now lives
 * in the shared package for use by scene graph builders and other pure consumers.
 */

export type { XY, GeometrySegment, CoordTransform } from "@simcloud/shared";
export {
  localToLonLat,
  sampleGeometry,
  resolveSTtoXY,
  resolveSTtoXYWithHeading,
  parseGeometrySegments,
  sampleRoadReferenceLineToLonLat,
} from "@simcloud/shared";
