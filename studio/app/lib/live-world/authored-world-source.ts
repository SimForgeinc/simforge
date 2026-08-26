'use client';

import type { SimScenarioInput } from '@simforge/engine';
import type { EditorDocument, ScenarioMapEntry } from '@simforge/editor';
import { ambientTrafficProviderFromExtensions } from '@simforge/playback/traffic';
import { TruthStreamClient } from '@simforge/training-env/browser';

import { playbackMapEntry } from '../scenario/maps';
import { ScenarioWorkerClient } from '../scenario/playback/scenarioWorkerClient';
import { previewAmbientTrafficProfile } from '../../dashboard/scenario/scene/previewPolicy';
import {
  assertControllableActor,
  authoredRoleIdForActor,
  selectAuthoredEgoActor,
} from './authored-world-session';
import type { LiveWorldWorkerRequest, LiveWorldWorkerResponse } from './worker-protocol';
import type { ControlInput, SpawnActorRequest, WorldSource, WorldSourceStatus } from './types';

export interface WorldTransport {
  readonly sessionId: string;
  readonly playing: boolean;
  readonly inspecting: boolean;
  readonly completed: boolean;
  readonly time: number;
  readonly duration: number;
  play(): void;
  stop(): void;
  reset(): void;
  playPause(): void;
  seek(seconds: number): void;
  exitInspection(): void;
}

export interface AuthoredWorldSource extends WorldSource {
  readonly transport: WorldTransport;
  subscribeTransport(fn: (t: WorldTransport) => void): () => void;
  readonly egoActorId: string | null;
  selectEgo(preferredActorId?: string | null): string | null;
  roleIdForActor(actorId: string): string | null;
  setEgo(actorId: string | null): void;
}

export async function createAuthoredWorldSource(opts: {
  document: EditorDocument;
  map: ScenarioMapEntry;
  tickHz?: number;
}): Promise<AuthoredWorldSource> {
  const compiler = new ScenarioWorkerClient();
  let input: SimScenarioInput;
  try {
    const bundle = await compiler.prepare(
      opts.document.data,
      playbackMapEntry(opts.map),
      previewAmbientTrafficProfile(
        ambientTrafficProviderFromExtensions(opts.document.data.extensions),
        opts.document.data.extensions,
        opts.document.data.mapSignalPlans.length > 0,
      ),
      undefined,
      { materializeOnly: true },
    );
    input = bundle.instance.input;
  } finally {
    compiler.dispose();
  }
  return new AuthoredWorkerWorldSource(input, opts.document, opts.map, opts.tickHz ?? 20);
}

let nextSessionId = 1;

class AuthoredWorkerWorldSource implements AuthoredWorldSource {
  private readonly worker: Worker;
  private readonly decoder = new TruthStreamClient();
  private readonly input: SimScenarioInput;
  private readonly roleIdByActorId: ReadonlyMap<string, string>;
  private readonly frameListeners = new Set<Parameters<WorldSource['subscribeFrames']>[0]>();
  private readonly statusListeners = new Set<Parameters<WorldSource['subscribeStatus']>[0]>();
  private readonly warningListeners = new Set<(message: string) => void>();
  private readonly transportListeners = new Set<(transport: WorldTransport) => void>();
  private readonly seenWarnings: string[] = [];
  private currentStatus: WorldSourceStatus = 'connecting';
  private currentError: string | null = null;
  private currentEgoActorId: string | null = null;
  private transportState: { playing: boolean; inspecting: boolean; completed: boolean; time: number };
  readonly transport: WorldTransport;

  constructor(input: SimScenarioInput, document: EditorDocument, map: ScenarioMapEntry, tickHz: number) {
    this.input = input;
    this.roleIdByActorId = matchCompiledActorsToRoles(input, document);
    this.transportState = { playing: false, inspecting: false, completed: false, time: 0 };
    const sessionId = `authored-world-${nextSessionId++}`;
    const source = this;
    this.transport = {
      sessionId,
      get playing() { return source.transportState.playing; },
      get inspecting() { return source.transportState.inspecting; },
      get completed() { return source.transportState.completed; },
      get time() { return source.transportState.time; },
      duration: input.clipSeconds,
      play: () => this.sendTransport('play'),
      stop: () => this.sendTransport('stop'),
      reset: () => this.sendTransport('reset'),
      playPause: () => this.sendTransport('playPause'),
      seek: (seconds) => this.seek(seconds),
      exitInspection: () => this.sendTransport('exitInspection'),
    };


    this.worker = new Worker(new URL('../../../worker/live-world-worker.ts', import.meta.url), {
      type: 'module',
      name: 'simforge-authored-world',
    });
    this.worker.onmessage = (event: MessageEvent<LiveWorldWorkerResponse>) => this.onMessage(event.data);
    this.worker.onerror = (event) => this.setStatus('error', event.message || 'authored world worker failed');
    this.worker.postMessage({
      type: 'init-authored',
      input,
      laneGraphUrl: map.topologyUrl,
      tickHz,
    } satisfies LiveWorldWorkerRequest);
  }

  get status(): WorldSourceStatus { return this.currentStatus; }
  get lastError(): string | null { return this.currentError; }
  get egoActorId(): string | null { return this.currentEgoActorId; }

  subscribeFrames(fn: Parameters<WorldSource['subscribeFrames']>[0]): () => void {
    this.frameListeners.add(fn);
    return () => this.frameListeners.delete(fn);
  }

  subscribeStatus(fn: Parameters<WorldSource['subscribeStatus']>[0]): () => void {
    this.statusListeners.add(fn);
    fn(this.currentStatus, this.currentError);
    return () => this.statusListeners.delete(fn);
  }

  subscribeWarnings(fn: (message: string) => void): () => void {
    this.warningListeners.add(fn);
    for (const message of this.seenWarnings) fn(message);
    return () => this.warningListeners.delete(fn);
  }

  subscribeTransport(fn: (transport: WorldTransport) => void): () => void {
    this.transportListeners.add(fn);
    fn(this.transport);
    return () => this.transportListeners.delete(fn);
  }

  selectEgo(preferredActorId: string | null = null): string | null {
    const preferredCompiledActorId = preferredActorId
      ? [...this.roleIdByActorId].find(([, roleId]) => roleId === preferredActorId)?.[0] ?? preferredActorId
      : null;
    return selectAuthoredEgoActor(this.input, preferredCompiledActorId);
  }

  roleIdForActor(actorId: string): string | null {
    const mappedRoleId = this.roleIdByActorId.get(actorId);
    if (mappedRoleId) return mappedRoleId;
    const actor = this.input.actors.find((candidate) => candidate.id === actorId);
    return actor ? authoredRoleIdForActor(actor) : null;
  }

  setEgo(actorId: string | null): void {
    if (actorId !== null) assertControllableActor(this.input, actorId);
    this.currentEgoActorId = actorId;
    this.worker.postMessage({ type: 'set-ego', actorId } satisfies LiveWorldWorkerRequest);
  }

  control(input: ControlInput): void {

    if (this.currentStatus !== 'running') return;
    if (this.currentEgoActorId === null) throw new Error('No authored ego vehicle is selected');
    if (this.transportState.completed) return;
    this.worker.postMessage({
      type: 'control',
      input: { ...input, actorId: this.currentEgoActorId },
    } satisfies LiveWorldWorkerRequest);
  }

  spawn(_request: SpawnActorRequest): Promise<{ actorId: string }> {
    return Promise.reject(new Error('Authored worlds can only contain actors compiled from the editor document'));
  }

  despawn(_actorId: string): Promise<void> {
    return Promise.reject(new Error('Authored actors cannot be despawned outside the editor document'));
  }

  close(): void {
    if (this.currentStatus === 'closed') return;
    this.worker.postMessage({ type: 'close' } satisfies LiveWorldWorkerRequest);
    this.worker.terminate();
    this.setStatus('closed', null);
    this.frameListeners.clear();
    this.statusListeners.clear();
    this.warningListeners.clear();
    this.transportListeners.clear();
  }

  private seek(seconds: number): void {
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > this.transport.duration) {
      throw new RangeError(`seek time must be within 0..${this.transport.duration} seconds`);
    }
    this.worker.postMessage({ type: 'transport', action: 'seek', seconds } satisfies LiveWorldWorkerRequest);
  }

  private sendTransport(action: 'play' | 'stop' | 'reset' | 'playPause' | 'exitInspection'): void {
    if (this.currentStatus === 'closed') throw new Error('authored world source is closed');
    this.worker.postMessage({ type: 'transport', action } satisfies LiveWorldWorkerRequest);
  }

  private onMessage(message: LiveWorldWorkerResponse): void {
    if (this.currentStatus === 'closed') return;
    if (message.type === 'ready') {
      this.setStatus('running', null);
      return;
    }
    if (message.type === 'frame') {
      try {
        for (const frame of this.decoder.push(new Uint8Array(message.bytes))) {

          for (const listener of this.frameListeners) listener(frame);
        }
      } catch (error) {
        this.setStatus('error', error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if (message.type === 'transport') {
      this.transportState = {
        playing: message.playing,
        inspecting: message.inspecting,
        completed: message.completed,
        time: message.time,
      };
      for (const listener of this.transportListeners) listener(this.transport);
      return;
    }
    if (message.type === 'warning') {
      this.seenWarnings.push(message.message);
      for (const listener of this.warningListeners) listener(message.message);
      return;
    }
    if (message.type === 'error') this.setStatus('error', message.message);
  }

  private setStatus(status: WorldSourceStatus, error: string | null): void {
    if (this.currentStatus === status && this.currentError === error) return;
    this.currentStatus = status;
    this.currentError = error;
    for (const listener of this.statusListeners) listener(status, error);
  }
}

function matchCompiledActorsToRoles(
  input: SimScenarioInput,
  document: EditorDocument,
): ReadonlyMap<string, string> {
  const roles = document.data.roles;
  const unusedRoleIds = new Set(roles.map((role) => role.id));
  const result = new Map<string, string>();
  for (const actor of input.actors) {
    const compiledRoleId = authoredRoleIdForActor(actor);
    const catalogId = actor.tags.find((tag) => tag.startsWith('catalog:'))?.slice('catalog:'.length);
    const classId = actor.tags.find((tag) => tag.startsWith('class:'))?.slice('class:'.length);
    const role = roles.find((candidate) =>
      unusedRoleIds.has(candidate.id) && candidate.id === compiledRoleId,
    ) ?? roles.find((candidate) =>
      unusedRoleIds.has(candidate.id)
      && catalogId !== undefined
      && candidate.actor.catalogId === catalogId,
    ) ?? roles.find((candidate) =>
      unusedRoleIds.has(candidate.id)
      && classId !== undefined
      && candidate.actor.class === classId,
    ) ?? roles.find((candidate) => unusedRoleIds.has(candidate.id));
    if (!role) continue;
    result.set(actor.id, role.id);
    unusedRoleIds.delete(role.id);
  }
  return result;
}

