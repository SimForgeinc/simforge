export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

export type ParityConfig = {
  sampleRateHz: number;
  position: {
    maxDeviationMeters: {
      vehicle: number;
      walker: number;
    };
    rmseMeters: number;
    endStateMeters: number;
  };
  speed: {
    smoothingWindowSeconds: number;
    maxDeltaMetersPerSecond: number;
  };
  collisionEvents: {
    presenceExact: boolean;
    maxTimingDeltaSeconds: number;
  };
  duration: {
    maxDeltaSeconds: number;
  };
};

/**
 * The complete v1 parity tolerance contract. Persist the resolved object with
 * every report so later config changes cannot alter the meaning of old runs.
 */
export const DEFAULT_PARITY_CONFIG: Readonly<ParityConfig> = Object.freeze({
  sampleRateHz: 20,
  position: Object.freeze({
    maxDeviationMeters: Object.freeze({
      vehicle: 1.5,
      walker: 0.75,
    }),
    rmseMeters: 0.6,
    endStateMeters: 1.0,
  }),
  speed: Object.freeze({
    smoothingWindowSeconds: 0.5,
    maxDeltaMetersPerSecond: 2.0,
  }),
  collisionEvents: Object.freeze({
    presenceExact: true,
    maxTimingDeltaSeconds: 0.5,
  }),
  duration: Object.freeze({
    maxDeltaSeconds: 0.25,
  }),
});

export function resolveParityConfig(
  override?: DeepPartial<ParityConfig>,
): ParityConfig {
  return {
    sampleRateHz: override?.sampleRateHz ?? DEFAULT_PARITY_CONFIG.sampleRateHz,
    position: {
      maxDeviationMeters: {
        vehicle:
          override?.position?.maxDeviationMeters?.vehicle ??
          DEFAULT_PARITY_CONFIG.position.maxDeviationMeters.vehicle,
        walker:
          override?.position?.maxDeviationMeters?.walker ??
          DEFAULT_PARITY_CONFIG.position.maxDeviationMeters.walker,
      },
      rmseMeters:
        override?.position?.rmseMeters ??
        DEFAULT_PARITY_CONFIG.position.rmseMeters,
      endStateMeters:
        override?.position?.endStateMeters ??
        DEFAULT_PARITY_CONFIG.position.endStateMeters,
    },
    speed: {
      smoothingWindowSeconds:
        override?.speed?.smoothingWindowSeconds ??
        DEFAULT_PARITY_CONFIG.speed.smoothingWindowSeconds,
      maxDeltaMetersPerSecond:
        override?.speed?.maxDeltaMetersPerSecond ??
        DEFAULT_PARITY_CONFIG.speed.maxDeltaMetersPerSecond,
    },
    collisionEvents: {
      presenceExact:
        override?.collisionEvents?.presenceExact ??
        DEFAULT_PARITY_CONFIG.collisionEvents.presenceExact,
      maxTimingDeltaSeconds:
        override?.collisionEvents?.maxTimingDeltaSeconds ??
        DEFAULT_PARITY_CONFIG.collisionEvents.maxTimingDeltaSeconds,
    },
    duration: {
      maxDeltaSeconds:
        override?.duration?.maxDeltaSeconds ??
        DEFAULT_PARITY_CONFIG.duration.maxDeltaSeconds,
    },
  };
}
