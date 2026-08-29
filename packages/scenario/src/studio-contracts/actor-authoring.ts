import { z } from 'zod';

/** Hard bounds accepted by the scenario authoring surface. */
export const VEHICLE_SPEED_CAP_KPH = 240;
export const WALKER_SPEED_CAP_KPH = 25;

/** Canonical initial speeds for newly authored actors. */
export const DEFAULT_AUTHORED_VEHICLE_SPEED_KPH = 48.28032;
export const DEFAULT_AUTHORED_WALKER_SPEED_KPH = 5;
export const DEFAULT_AUTHORED_CYCLIST_SPEED_KPH = 18;
export const DEFAULT_AUTHORED_DRONE_SPEED_KPH = 18;
export const DEFAULT_AUTHORED_SIDEWALK_ROBOT_SPEED_KPH = 6;

/** Newly authored vehicles use deterministic authored behavior, not Traffic Manager. */
export const DEFAULT_AUTHORED_ACTOR_AUTOPILOT = false;
/** CARLA's comma-separated RGB wire representation. */
export const DEFAULT_AUTHORED_VEHICLE_COLOR = '230,200,40';

export const ActorAuthoringPolicySchema = z.strictObject({
  vehicleSpeedCapKph: z.literal(VEHICLE_SPEED_CAP_KPH),
  walkerSpeedCapKph: z.literal(WALKER_SPEED_CAP_KPH),
  defaultAutopilot: z.literal(DEFAULT_AUTHORED_ACTOR_AUTOPILOT),
  defaultVehicleColor: z.literal(DEFAULT_AUTHORED_VEHICLE_COLOR),
});
export type ActorAuthoringPolicy = z.infer<typeof ActorAuthoringPolicySchema>;

export const ACTOR_AUTHORING_POLICY: ActorAuthoringPolicy = Object.freeze({
  vehicleSpeedCapKph: VEHICLE_SPEED_CAP_KPH,
  walkerSpeedCapKph: WALKER_SPEED_CAP_KPH,
  defaultAutopilot: DEFAULT_AUTHORED_ACTOR_AUTOPILOT,
  defaultVehicleColor: DEFAULT_AUTHORED_VEHICLE_COLOR,
});
