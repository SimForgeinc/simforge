import type { TruthFrame } from '@simforge-oss/training-env/browser';

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

export interface WorldClock {
  mode: 'live' | 'replay';
  timeIso: string | null;
  speed: number;
  tracks: number;
}

export interface TrajectoryPlaybackStatus {
  active: boolean;
  name?: string;
  elapsed?: number;
  duration?: number;
  vehicleId?: string;
  finished?: boolean;
  error?: string;
}

export interface WorldReplayCapabilities {
  retentionHours: number;
  archiveOffsetSeconds: number;
  archiveUrlTemplate: string | null;
  coverageUrl: string | null;
  historyUrl: string | null;
}


export interface WorldSource {
  readonly status: WorldSourceStatus;
  readonly lastError: string | null;
  readonly replay?: WorldReplayCapabilities | null;
  subscribeFrames(fn: (frame: TruthFrame) => void): () => void;
  subscribeStatus(fn: (status: WorldSourceStatus, error: string | null) => void): () => void;
  subscribeReplay?(fn: (capabilities: WorldReplayCapabilities | null, error: string | null) => void): () => void;
  /**
   * Non-fatal notices about a world that is running but will behave in a way the
   * operator would otherwise misread — e.g. no lane graph, so every road actor
   * is refused. Optional: not every source can produce them.
   */
  subscribeWarnings?(fn: (message: string) => void): () => void;
  spawn(req: SpawnActorRequest): Promise<{ actorId: string }>;
  despawn(actorId: string): Promise<void>;
  control(input: ControlInput): void;
  subscribeClock?(fn: (clock: WorldClock) => void): () => void;
  setReplay?(opts: { startIso: string; speed?: number }): Promise<void>;
  setLive?(): Promise<void>;
  listTrajectories?(): Promise<ReadonlyArray<{ file: string; name?: string }>>;
  startTrajectory?(file: string): Promise<void>;
  stopTrajectory?(): Promise<void>;
  /**
   * The drive protocol exposes trajectory state as a request rather than a
   * push. Remote sources poll it only while a consumer is subscribed.
   */
  subscribeTrajectoryStatus?(fn: (status: TrajectoryPlaybackStatus) => void): () => void;
  close(): void;
}
