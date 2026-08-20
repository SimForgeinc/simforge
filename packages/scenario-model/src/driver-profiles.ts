import { z } from 'zod';

/** Stable authored driver policies. Physical vehicle parameters stay separate. */
export const DRIVER_PROFILE_IDS = ['lawful', 'cautious', 'assertive', 'violator'] as const;

export const DriverProfileSchema = z.enum(DRIVER_PROFILE_IDS);
export type DriverProfile = z.infer<typeof DriverProfileSchema>;

export interface DriverProfileDefinition {
  readonly id: DriverProfile;
  readonly label: string;
  readonly description: string;
  /** Human comfort targets. Vehicle physics remains the hard feasibility cap. */
  readonly dynamics: {
    readonly comfortableLateralAccelerationMps2: number;
    readonly comfortableDecelerationMps2: number;
  };
  readonly rules: {
    readonly obeySignals: boolean;
    readonly yield: boolean;
    readonly yieldToVehicles: boolean;
    readonly yieldToPedestrians: boolean;
    readonly collisionAvoidance: boolean;
    readonly aggression: number;
    readonly speedFactor: number;
  };
}

export const DRIVER_PROFILES: Readonly<Record<DriverProfile, DriverProfileDefinition>> = {
  lawful: {
    id: 'lawful', label: 'Normal (lawful)',
    description: 'Everyday acceleration and cornering while obeying signals and right-of-way.',
    dynamics: { comfortableLateralAccelerationMps2: 2.2, comfortableDecelerationMps2: 2.5 },
    rules: { obeySignals: true, yield: true, yieldToVehicles: true, yieldToPedestrians: true, collisionAvoidance: true, aggression: 0.5, speedFactor: 1 },
  },
  cautious: {
    id: 'cautious', label: 'Cautious',
    description: 'Brakes earlier, corners gently, leaves larger gaps, and drives below the free-flow limit.',
    dynamics: { comfortableLateralAccelerationMps2: 1.4, comfortableDecelerationMps2: 1.8 },
    rules: { obeySignals: true, yield: true, yieldToVehicles: true, yieldToPedestrians: true, collisionAvoidance: true, aggression: 0.2, speedFactor: 0.9 },
  },
  assertive: {
    id: 'assertive', label: 'Assertive',
    description: 'Brakes later, carries more speed through turns, and accepts tighter gaps while remaining lawful.',
    dynamics: { comfortableLateralAccelerationMps2: 3.2, comfortableDecelerationMps2: 3.2 },
    rules: { obeySignals: true, yield: true, yieldToVehicles: true, yieldToPedestrians: true, collisionAvoidance: true, aggression: 0.8, speedFactor: 1.05 },
  },
  violator: {
    id: 'violator', label: 'Normal (traffic-law violator)',
    description: 'Uses normal cornering comfort, may run controls, and retains collision avoidance.',
    dynamics: { comfortableLateralAccelerationMps2: 2.2, comfortableDecelerationMps2: 2.5 },
    rules: { obeySignals: false, yield: false, yieldToVehicles: false, yieldToPedestrians: false, collisionAvoidance: true, aggression: 0.85, speedFactor: 1.1 },
  },
};

export function driverProfileDefinition(profile: DriverProfile | undefined): DriverProfileDefinition {
  return DRIVER_PROFILES[profile ?? 'lawful'];
}
