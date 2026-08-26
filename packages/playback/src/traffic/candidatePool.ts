import { contentHash, type ResolvedAmbientTrafficProfile } from '@simforge-oss/engine';

/** Request identity; the worker replaces mapId with the loaded graph digest. */
export function ambientCandidatePoolRequestKey(mapId: string, profile: ResolvedAmbientTrafficProfile): string {
  return contentHash({ mapId, profile });
}

export function ambientPreviewKey(candidatePoolRequestKey: string, simulationSourceHash: string): string {
  return contentHash({ candidatePoolRequestKey, simulationSourceHash });
}

export interface AmbientPreviewEntry<T> {
  readonly candidatePoolRequestKey: string;
  readonly previewKey: string;
  /** EditorDocument revision this concrete preview was compiled from. */
  readonly revision: number;
  readonly value: T;
}

/** A rendered preview is owned by the exact document revision that produced it. */
export interface RevisionOwnedPreview<T> {
  readonly previewKey: string;
  readonly revision: number;
  readonly value: T;
}

/** Never expose a compiled preview across an edit, rebind, undo, or failed rebuild. */
export function previewForRevision<T>(
  preview: RevisionOwnedPreview<T> | null,
  previewKey: string | null,
  revision?: number,
): T | null {
  return revision !== undefined && preview?.revision === revision && preview.previewKey === previewKey
    ? preview.value
    : null;
}

/** Race-safe cache for the latest compiled preview. Candidate identity lives in the engine pool. */
export class AmbientPreviewCache<T> {
  private committed: AmbientPreviewEntry<T> | null = null;
  private generation = 0;

  get current(): AmbientPreviewEntry<T> | null { return this.committed; }
  begin(): number { return ++this.generation; }

  commit(token: number, entry: AmbientPreviewEntry<T>): boolean {
    if (token !== this.generation) return false;
    this.committed = entry;
    return true;
  }

  fail(token: number): boolean {
    if (token !== this.generation) return false;
    this.generation++;
    return true;
  }

  playback(revision?: number): T | null {
    if (revision !== undefined && this.committed?.revision !== revision) return null;
    return this.committed?.value ?? null;
  }
}

