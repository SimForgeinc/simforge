import type {
  Detector,
  DetectorResult,
  MapSceneGraph,
} from "../../map-intelligence";
import { intersectionDetector } from "./intersection-detector";
import { turnDetector } from "./turn-detector";
import { crosswalkDetector } from "./crosswalk-detector";
import { parkingDetector } from "./parking-detector";
import { roadDetector } from "./road-detector";

export { intersectionDetector } from "./intersection-detector";
export { turnDetector } from "./turn-detector";
export { crosswalkDetector } from "./crosswalk-detector";
export { parkingDetector } from "./parking-detector";
export { roadDetector } from "./road-detector";

export const DETECTOR_REGISTRY: Detector[] = [
  intersectionDetector,
  turnDetector,
  crosswalkDetector,
  parkingDetector,
  roadDetector,
];

export function runAllDetectors(sceneGraph: MapSceneGraph): DetectorResult[] {
  return DETECTOR_REGISTRY.flatMap((d) => d.detect(sceneGraph));
}
