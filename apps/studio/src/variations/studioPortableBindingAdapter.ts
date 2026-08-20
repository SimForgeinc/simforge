import { normalizeDerivedMapIndex, type DerivedMapIndex } from '@uniscenarios/anchor-matcher';
import {
  liftMapBoundTemplate,
  type PortableLiftOptions,
} from '@uniscenarios/scenario-materializer';
import type { ScenarioTemplateV2 } from '@uniscenarios/scenario-model';
import type { TopologyIndex } from '@uniscenarios/sim-engine';
import type {
  PortableBindingAdapter,
  PortableBindingResult,
  VariationMapSource,
} from './model';

export const STUDIO_PORTABLE_BINDING_CONTRACT = 'studio.portable-lift.v1';
export const SIGNAL_APPROACH_EXTENSION = 'studio.variation.signalApproaches';

/** Browser adapter for the materializer-owned reverse-materialization seam. */
export class StudioPortableBindingAdapter implements PortableBindingAdapter {
  readonly contractVersion = STUDIO_PORTABLE_BINDING_CONTRACT;
  private readonly indexCache = new Map<string, Promise<DerivedMapIndex>>();

  async bind(template: ScenarioTemplateV2, sourceMap: VariationMapSource): Promise<PortableBindingResult> {
    if (template.roles.length > 0 && template.roles.every((role) => role.kind !== 'scene_absolute')) {
      // Already-portable documents are bound against the source inside the
      // worker, which owns map matching and simulation.
      return { ok: true, issues: [] };
    }
    if (template.roles.some((role) => role.kind === 'scene_absolute')
      && template.roles.some((role) => role.kind !== 'scene_absolute')) {
      return {
        ok: false,
        issues: [{
          code: 'role_binding_ambiguous',
          severity: 'error',
          path: 'roles',
          message: 'the document mixes map-bound and portable role bindings',
          dependency: 'finish rebinding every role into one coordinate system before searching for variations',
          retryable: true,
        }],
      };
    }
    const index = await this.loadIndex(sourceMap);
    const signalApproaches = signalApproachesFrom(template);
    const options: PortableLiftOptions = {
      origin: 'auto',
      allowMirror: true,
      ...(signalApproaches ? { signalApproaches } : {}),
    };
    const lifted = liftMapBoundTemplate(template, index, options);
    if (!lifted.ok || !lifted.template || !lifted.sourceSite) {
      return { ok: false, issues: lifted.issues };
    }
    return {
      ok: true,
      binding: { template: lifted.template, sourceSite: lifted.sourceSite },
      issues: lifted.issues,
    };
  }

  private loadIndex(sourceMap: VariationMapSource): Promise<DerivedMapIndex> {
    const key = `${sourceMap.id}:${sourceMap.topology}:${sourceMap.derivedTopology}:${sourceMap.locations}`;
    let pending = this.indexCache.get(key);
    if (!pending) {
      pending = Promise.all([fetchJson(sourceMap.topology), fetchJson(sourceMap.derivedTopology), fetchJson(sourceMap.locations)])
        .then(([topology, derived, locations]) => normalizeDerivedMapIndex(derived, { mapId: sourceMap.id, topology: topology as TopologyIndex as never, locations }));
      this.indexCache.set(key, pending);
    }
    return pending;
  }
}

function signalApproachesFrom(template: ScenarioTemplateV2): PortableLiftOptions['signalApproaches'] | undefined {
  const raw = template.extensions?.[SIGNAL_APPROACH_EXTENSION];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: NonNullable<PortableLiftOptions['signalApproaches']> = {};
  for (const [handle, value] of Object.entries(raw as Record<string, unknown>)) {
    // Persisted extension values used `ego`; normalize them before any lift can emit a new document.
    if (value === 'ego') out[handle] = 'subject';
    else if (value === 'subject' || value === 'opposing' || value === 'left' || value === 'right') out[handle] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load ${url}: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot decode gzip map artifacts');
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function fetchJson(url: string): Promise<unknown> {
  return JSON.parse(new TextDecoder().decode(await fetchBytes(url))) as unknown;
}
