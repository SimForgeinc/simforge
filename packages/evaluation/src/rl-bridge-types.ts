/**
 * Structural types for the pieces of the rl stack policy-eval consumes at
 * runtime (see runtime.ts for why these are structural rather than a
 * workspace dependency). Shapes mirror @simforge-oss/engine,
 * @simforge-oss/compiler and @simforge-oss/training-env.
 */

export interface SessionPairMinima {
  readonly a: string;
  readonly b: string;
  readonly minDistanceM: number;
  readonly minTtcS: number;
  readonly minPathTtcS: number;
  readonly minPetS: number;
}

export interface StepResult {
  readonly reward: number;
  readonly terminated: boolean;
  readonly truncated: boolean;
  readonly info: {
    readonly tS: number;
    readonly minima: readonly SessionPairMinima[];
    readonly rewardTerms: Record<string, number>;
  };
}

export interface EnvSession {
  readonly ego: string;
  reset(seed?: number | string): StepResult & { observation: unknown };
  step(action?: Record<string, unknown>): StepResult & { observation: unknown };
}

export interface MapBundle {
  readonly mapId: string;
  readonly graph: unknown;
}

export interface MatchedSite {
  readonly siteId: string;
}

export interface MaterializeOptions {
  readonly seed?: string | undefined;
  readonly variant?:
    | {
        readonly id: string;
        readonly title: string;
        readonly weather: string;
        readonly timeOfDay: string;
        readonly traffic: string;
        readonly visibility: string;
      }
    | undefined;
}

export interface MaterializeResult {
  readonly input: Record<string, unknown> & { clipSeconds: number };
}
