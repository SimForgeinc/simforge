import type { TruthFrame } from '@simforge/training-env/browser';

export type WorldSourceStatus = 'idle' | 'connecting' | 'running' | 'error' | 'closed';

export interface SpawnActorRequest {
  blueprint: string;
  position: { x: number; y: number; z?: number };
  headingRad?: number;
  speedMps?: number;
  controlled?: boolean;
}

export interface ControlInput {
  actorId: string;
  steer: number;
  throttle: number;
  brake: number;
  reverse?: boolean;
}

export interface WorldSource {
  readonly status: WorldSourceStatus;
  readonly lastError: string | null;
  subscribeFrames(fn: (frame: TruthFrame) => void): () => void;
  subscribeStatus(fn: (status: WorldSourceStatus, error: string | null) => void): () => void;
  /**
   * Non-fatal notices about a world that is running but will behave in a way the
   * operator would otherwise misread — e.g. no lane graph, so every road actor
   * is refused. Optional: not every source can produce them.
   */
  subscribeWarnings?(fn: (message: string) => void): () => void;
  spawn(req: SpawnActorRequest): Promise<{ actorId: string }>;
  despawn(actorId: string): Promise<void>;
  control(input: ControlInput): void;
  close(): void;
}
