/**
 * World-session registry — multi-client sessions over {@link WorldSession}.
 *
 * ## Roles
 *
 * - `tick-owner`       — exactly one per world; the only client allowed to
 *                        advance time. Ownership is released on leave and can
 *                        be claimed by any member while vacant.
 * - `actor-controller` — may queue world commands (spawn/despawn/batch/act).
 * - `observer`         — read-only (snapshots, session log).
 *
 * ## Ordering
 *
 * No command mutates the world when it is submitted. Every command queues,
 * and the tick-owner's `advance` drains the queue at the tick boundary in
 * deterministic order: **client id ascending, then per-client seq ascending**.
 * Client ids are registry-allocated, zero-padded (`c0001`), so lexicographic
 * order equals allocation order. The tick-owner's own commands queue exactly
 * like everyone else's — one rule, no special cases.
 *
 * The wire layer (`registerWorldOps`) exposes the registry as namespaced
 * `world.*` ops through the env-server's extension seam; the op payloads are
 * validated here, at the boundary, with zod.
 */

import { z } from 'zod';

import { ACTOR_KINDS, type LaneGraph, type SimScenarioInput } from '@simforge/engine';

import type { EnvServer, WireRequest } from './env-server.js';
import {
  WorldSession,
  type AdvanceResult,
  type CommandOutcome,
  type WorldCommand,
  type WorldSessionLog,
  type WorldSnapshot,
} from './world-session.js';

export type SessionRole = 'tick-owner' | 'observer' | 'actor-controller';

/** One world template the registry can instantiate (an env-server episode). */
export interface WorldEpisode {
  readonly input: SimScenarioInput;
  readonly graph: LaneGraph;
}

export interface QueuedCommandResult extends CommandOutcome {
  readonly clientId: string;
  readonly seq: number;
}

export interface WorldAdvanceResult extends AdvanceResult {
  /** Per-command outcomes for everything drained at this boundary, in applied order. */
  readonly results: readonly QueuedCommandResult[];
}

interface Member {
  role: SessionRole;
  nextSeq: number;
}

interface QueuedCommand {
  readonly clientId: string;
  readonly seq: number;
  readonly command: WorldCommand;
}

interface WorldEntry {
  readonly world: WorldSession;
  readonly members: Map<string, Member>;
  tickOwner: string | null;
  queue: QueuedCommand[];
}

export class WorldRegistry {
  private readonly worlds = new Map<string, WorldEntry>();
  private worldCounter = 0;
  private clientCounter = 0;

  constructor(private readonly episodes: readonly WorldEpisode[]) {
    if (episodes.length === 0) throw new Error('WorldRegistry needs at least one episode template');
  }

  /** Instantiate a world from an episode template; the creator joins with `role`. */
  createWorld(options: { episode?: number; horizonSeconds?: number; role?: SessionRole } = {}): {
    worldId: string;
    clientId: string;
    role: SessionRole;
  } {
    const episode = this.episodes[options.episode ?? 0];
    if (!episode) throw new Error(`no episode ${String(options.episode)} (registry has ${this.episodes.length})`);
    const worldId = `w${String(++this.worldCounter).padStart(4, '0')}`;
    const world = new WorldSession({
      input: episode.input,
      graph: episode.graph,
      ...(options.horizonSeconds !== undefined ? { horizonSeconds: options.horizonSeconds } : {}),
    });
    this.worlds.set(worldId, { world, members: new Map(), tickOwner: null, queue: [] });
    const { clientId, role } = this.join(worldId, options.role ?? 'tick-owner');
    return { worldId, clientId, role };
  }

  join(worldId: string, role: SessionRole = 'observer'): { clientId: string; role: SessionRole } {
    const entry = this.requireWorld(worldId);
    if (role === 'tick-owner' && entry.tickOwner !== null) {
      throw new Error(`world ${worldId} already has tick-owner ${entry.tickOwner}`);
    }
    const clientId = `c${String(++this.clientCounter).padStart(4, '0')}`;
    entry.members.set(clientId, { role, nextSeq: 0 });
    if (role === 'tick-owner') entry.tickOwner = clientId;
    return { clientId, role };
  }

  /**
   * Leave the world. A departing tick-owner releases ownership; time halts
   * until a remaining member claims it. Already-queued commands from the
   * departed client stay queued — they were accepted while it was a member,
   * and dropping them would make the session log depend on leave timing.
   */
  leave(worldId: string, clientId: string): void {
    const entry = this.requireWorld(worldId);
    if (!entry.members.delete(clientId)) throw new Error(`client ${clientId} is not a member of ${worldId}`);
    if (entry.tickOwner === clientId) entry.tickOwner = null;
  }

  /** Claim vacant tick ownership. */
  claimTickOwnership(worldId: string, clientId: string): void {
    const entry = this.requireWorld(worldId);
    const member = this.requireMember(entry, worldId, clientId);
    if (entry.tickOwner !== null && entry.tickOwner !== clientId) {
      throw new Error(`world ${worldId} already has tick-owner ${entry.tickOwner}`);
    }
    entry.tickOwner = clientId;
    member.role = 'tick-owner';
  }

  /** Queue one command for the next tick boundary. Observers are read-only. */
  enqueue(worldId: string, clientId: string, command: WorldCommand): { seq: number } {
    const entry = this.requireWorld(worldId);
    const member = this.requireMember(entry, worldId, clientId);
    if (member.role === 'observer') throw new Error(`client ${clientId} is an observer; commands are refused`);
    const seq = member.nextSeq++;
    entry.queue.push({ clientId, seq, command });
    return { seq };
  }

  /**
   * Tick-owner only: drain the queue in (clientId, seq) order at the current
   * tick boundary, then advance the engine by `ticks`.
   */
  advance(worldId: string, clientId: string, ticks: number): WorldAdvanceResult {
    const entry = this.requireWorld(worldId);
    this.requireMember(entry, worldId, clientId);
    if (entry.tickOwner !== clientId) {
      throw new Error(`client ${clientId} is not the tick-owner of ${worldId}${entry.tickOwner === null ? ' (ownership vacant; claim it first)' : ''}`);
    }
    const drained = entry.queue;
    entry.queue = [];
    drained.sort((a, b) =>
      a.clientId < b.clientId ? -1 : a.clientId > b.clientId ? 1 : a.seq - b.seq,
    );
    const results: QueuedCommandResult[] = drained.map((q) => ({
      clientId: q.clientId,
      seq: q.seq,
      ...entry.world.applyCommand(q.clientId, q.seq, q.command),
    }));
    const advanced = entry.world.advance(ticks);
    return { ...advanced, results };
  }

  snapshot(worldId: string, clientId: string): WorldSnapshot {
    const entry = this.requireWorld(worldId);
    this.requireMember(entry, worldId, clientId);
    return entry.world.snapshot();
  }

  exportLog(worldId: string, clientId: string): WorldSessionLog {
    const entry = this.requireWorld(worldId);
    this.requireMember(entry, worldId, clientId);
    return entry.world.exportLog();
  }

  private requireWorld(worldId: string): WorldEntry {
    const entry = this.worlds.get(worldId);
    if (!entry) throw new Error(`no world ${worldId}`);
    return entry;
  }

  private requireMember(entry: WorldEntry, worldId: string, clientId: string): Member {
    const member = entry.members.get(clientId);
    if (!member) throw new Error(`client ${clientId} is not a member of ${worldId}`);
    return member;
  }
}

/* ------------------------------------------------------------- wire layer */

const roleSchema = z.enum(['tick-owner', 'observer', 'actor-controller']);

const spawnRequestSchema = z.object({
  id: z.string().min(1).optional(),
  kind: z.enum(ACTOR_KINDS),
  pose: z.object({ x: z.number().finite(), z: z.number().finite(), headingRad: z.number().finite().optional() }),
  speedMps: z.number().finite().min(0).optional(),
  dims: z.object({ l: z.number().finite().gt(0), w: z.number().finite().gt(0), h: z.number().finite().gt(0) }).optional(),
  route: z.record(z.string(), z.unknown()).optional(),
  cruiseSpeedMps: z.number().finite().min(0).optional(),
  snapToLane: z.boolean().optional(),
  static: z.boolean().optional(),
  tags: z.array(z.string()).optional(),
});

const actionOverrideSchema = z.object({
  motionDirection: z.union([z.literal(1), z.literal(-1)]).optional(),
  targetSpeedMps: z.number().finite().min(0).optional(),
  targetAccelerationMps2: z.number().finite().optional(),
  control: z
    .object({ throttle: z.number().finite(), brake: z.number().finite(), steer: z.number().finite() })
    .optional(),
});

const batchOpSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('spawn'), spawn: spawnRequestSchema }),
  z.object({ kind: z.literal('despawn'), actorId: z.string().min(1) }),
]);

const worldCommandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('spawn'), spawn: spawnRequestSchema }),
  z.object({ kind: z.literal('despawn'), actorId: z.string().min(1) }),
  z.object({ kind: z.literal('batch'), ops: z.array(batchOpSchema).min(1) }),
  z.object({ kind: z.literal('act'), actorId: z.string().min(1), action: actionOverrideSchema.nullable() }),
]);

const worldRef = { w: z.string().min(1), c: z.string().min(1) };

/**
 * Register the `world.*` op family on an {@link EnvServer} through its
 * extension seam (see `registerOp` in env-server.ts, landed by PolicyStep).
 * Compact keys follow the existing wire style: `w` world, `c` client,
 * `n` ticks, `cmd` command.
 */
export function registerWorldOps(server: EnvServer, episodes: readonly WorldEpisode[]): WorldRegistry {
  const registry = new WorldRegistry(episodes);
  const ops: Record<string, (request: WireRequest) => unknown> = {
    'world.create': (request) => {
      const args = z
        .object({ e: z.number().int().nonnegative().optional(), horizonS: z.number().finite().gt(0).optional(), role: roleSchema.optional() })
        .parse(request);
      return registry.createWorld({ episode: args.e, horizonSeconds: args.horizonS, role: args.role });
    },
    'world.join': (request) => {
      const args = z.object({ w: worldRef.w, role: roleSchema.optional() }).parse(request);
      return registry.join(args.w, args.role);
    },
    'world.leave': (request) => {
      const args = z.object(worldRef).parse(request);
      registry.leave(args.w, args.c);
      return { left: true };
    },
    'world.claim': (request) => {
      const args = z.object(worldRef).parse(request);
      registry.claimTickOwnership(args.w, args.c);
      return { tickOwner: true };
    },
    'world.cmd': (request) => {
      const args = z.object({ ...worldRef, cmd: worldCommandSchema }).parse(request);
      // Schema output is structurally a WorldCommand; `route` stays loose here
      // and is re-validated by the engine input schema inside WorldSession.
      return registry.enqueue(args.w, args.c, args.cmd as WorldCommand);
    },
    'world.advance': (request) => {
      const args = z.object({ ...worldRef, n: z.number().int().positive().default(1) }).parse(request);
      return registry.advance(args.w, args.c, args.n);
    },
    'world.snapshot': (request) => {
      const args = z.object(worldRef).parse(request);
      return registry.snapshot(args.w, args.c);
    },
    'world.log': (request) => {
      const args = z.object(worldRef).parse(request);
      return registry.exportLog(args.w, args.c);
    },
  };
  for (const [op, handler] of Object.entries(ops)) server.registerOp(op, handler);
  return registry;
}
