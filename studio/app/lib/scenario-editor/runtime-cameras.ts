import type { MapAsset } from "@simforge-oss/studio-shared";
import { localPointToLngLat, runtimePointToLngLat } from "@/app/lib/editor-map/coordinates";
import {
  carlaYawForwardVector,
  runtimePointToEditorLocalPoint,
  visualYawFromRuntimeVector,
  worldCameraVisualYawToCarlaYaw,
  worldSensorVisualForwardVector,
} from "@/app/lib/editor-map/coordinate-frames";
import { rotateStreetCameraYawClockwise } from "@/app/lib/scenario-editor/street-camera-yaw";
import type { WorldSensorRecord } from "@/app/lib/scenario-editor/types";

export type RuntimeStreetFurniturePoint = {
  x: number;
  y: number;
  z: number;
  yaw: number;
};

export type RuntimeTrafficLight = RuntimeStreetFurniturePoint & {
  actor_id?: number;
  type_id?: string;
  pole_index?: number;
  opendrive_id?: string;
  stop_waypoints?: RuntimeStreetFurniturePoint[];
};

export type RuntimeStreetFurniture = {
  poles: Array<RuntimeStreetFurniturePoint & { id?: number | string; name?: string }>;
  traffic_lights: RuntimeTrafficLight[];
};

type GeoJsonPointFeature = {
  type: "Feature";
  geometry: {
    type: "Point";
    coordinates: [number, number];
  };
  properties: Record<string, unknown>;
};

type GeoJsonFeatureCollection = {
  type: "FeatureCollection";
  features: GeoJsonPointFeature[];
};

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function worldSensorFacesRuntimePoint(
  sensor: WorldSensorRecord,
  runtimePoint: { x: number; y: number },
) {
  const targetLocal = runtimePointToEditorLocalPoint(runtimePoint);
  const toTarget = {
    x: targetLocal.x - sensor.pose.x,
    y: targetLocal.y - sensor.pose.y,
  };
  const distance = Math.hypot(toTarget.x, toTarget.y);
  if (distance < 1e-6) return false;
  const forward = worldSensorVisualForwardVector(sensor.pose.yaw);
  return (forward.x * toTarget.x + forward.y * toTarget.y) / distance > 0;
}

export function carlaYawFromWorldSensorYaw(yaw: number) {
  return worldCameraVisualYawToCarlaYaw(yaw);
}

export function worldSensorFacesCarlaRuntimePoint(
  sensor: WorldSensorRecord,
  runtimePoint: { x: number; y: number },
) {
  const sensorCarlaPoint = { x: sensor.pose.x, y: sensor.pose.y };
  const toTarget = {
    x: runtimePoint.x - sensorCarlaPoint.x,
    y: runtimePoint.y - sensorCarlaPoint.y,
  };
  const distance = Math.hypot(toTarget.x, toTarget.y);
  if (distance < 1e-6) return false;
  const forward = carlaYawForwardVector(carlaYawFromWorldSensorYaw(sensor.pose.yaw));
  return (forward.x * toTarget.x + forward.y * toTarget.y) / distance > 0;
}

export function streetCameraYawForTrafficLight(light: RuntimeTrafficLight) {
  const stopWaypoint = light.stop_waypoints?.find(
    (point) => finiteNumber(point.x) && finiteNumber(point.y),
  );
  let trafficLightYaw: number;
  if (!stopWaypoint) {
    const radians = ((finiteNumber(light.yaw) ? light.yaw : 0) * Math.PI) / 180;
    trafficLightYaw = visualYawFromRuntimeVector({
      x: Math.cos(radians),
      y: Math.sin(radians),
    });
  } else {
    trafficLightYaw = visualYawFromRuntimeVector({
      x: stopWaypoint.x - light.x,
      y: stopWaypoint.y - light.y,
    });
  }
  return rotateStreetCameraYawClockwise(trafficLightYaw);
}

export function buildTrafficLightAnchoredWorldCamera(
  light: RuntimeTrafficLight,
  existingSensors: WorldSensorRecord[],
  buildWorldCamera: (
    mode: "street",
    point: { x: number; y: number },
    existingSensors: WorldSensorRecord[],
  ) => WorldSensorRecord,
): WorldSensorRecord {
  const sensor = buildWorldCamera(
    "street",
    runtimePointToEditorLocalPoint({ x: light.x, y: light.y }),
    existingSensors,
  );
  return {
    ...sensor,
    pose: {
      ...sensor.pose,
      yaw: streetCameraYawForTrafficLight(light),
    },
  };
}

function isSameCameraLocation(sensor: WorldSensorRecord, light: RuntimeTrafficLight) {
  return (
    sensor.sensorCategory === "camera" &&
    sensor.attachTo === "world" &&
    Math.hypot(sensor.pose.x - light.x, sensor.pose.y + light.y) < 0.25
  );
}

export function snapStreetCameraToTrafficLight(
  runtimePoint: { x: number; y: number },
  trafficLights: RuntimeTrafficLight[],
  snapRadius: number = 5,
): { point: { x: number; y: number }; light: RuntimeTrafficLight } | null {
  let bestDist = Infinity;
  let bestLight: RuntimeTrafficLight | null = null;
  for (const light of trafficLights) {
    if (!finiteNumber(light.x) || !finiteNumber(light.y)) continue;
    const dist = Math.hypot(light.x - runtimePoint.x, light.y - runtimePoint.y);
    if (dist < bestDist) {
      bestDist = dist;
      bestLight = light;
    }
  }
  if (!bestLight || bestDist >= snapRadius) return null;
  return { point: { x: bestLight.x, y: bestLight.y }, light: bestLight };
}

export function buildRuntimeTrafficLightGeoJSON(
  trafficLights: RuntimeTrafficLight[],
  asset: MapAsset | null,
  existingSensors?: WorldSensorRecord[],
): GeoJsonFeatureCollection | null {
  if (!asset || trafficLights.length === 0) return null;
  const features = trafficLights.flatMap((light): GeoJsonPointFeature[] => {
    if (!finiteNumber(light.x) || !finiteNumber(light.y)) return [];
    if (existingSensors?.some((sensor) => isSameCameraLocation(sensor, light))) return [];
    const coordinates = runtimePointToLngLat({ x: light.x, y: light.y }, asset);
    if (!coordinates) return [];
    return [{
      type: "Feature",
      geometry: { type: "Point", coordinates },
      properties: {
        signal_category: "traffic_light",
        actor_id: light.actor_id ?? null,
        opendrive_id: light.opendrive_id ?? null,
        pole_index: light.pole_index ?? null,
      },
    }];
  });
  return features.length > 0 ? { type: "FeatureCollection", features } : null;
}

export function buildWorldSensorGeoJSON(
  sensors: WorldSensorRecord[],
  asset: MapAsset | null,
  selectedWorldSensorId: string | null,
): GeoJsonFeatureCollection | null {
  if (!asset || sensors.length === 0) return null;
  const features = sensors.flatMap((sensor): GeoJsonPointFeature[] => {
    const coordinates = localPointToLngLat(sensor.pose, asset);
    if (!coordinates) return [];
    return [{
      type: "Feature",
      geometry: { type: "Point", coordinates },
      properties: {
        id: sensor.id,
        label: sensor.label,
        selected: sensor.id === selectedWorldSensorId,
        camera_kind: sensor.pose.z > 25 ? "overhead" : "street",
        yaw: sensor.pose.yaw,
      },
    }];
  });
  return features.length > 0 ? { type: "FeatureCollection", features } : null;
}
