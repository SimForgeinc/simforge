import type { CameraView } from '../index.js';
import type { ScenarioTemplateV2 } from '@simforge/scenario';

/** Presentation-only metadata. It is intentionally outside SimScenarioInput. */
export const CAMERA_EXTENSION_KEY = 'studio.presentation.cameras.v1';

export type CameraPolicy = 'editor' | 'all-actors' | 'subject-chase' | 'dash-camera' | 'authored' | 'auto-incident' | 'free';

export type CameraAttachment =
  | { kind: 'actor'; id: string }
  | { kind: 'traffic-signal'; id: string; approach?: string }
  | { kind: 'map-feature'; id: string };

export interface AuthoredCamera extends CameraView {
  id: string;
  name: string;
  attachment?: CameraAttachment;
  /** Marks a view for companion metadata export, never native ASAM camera export. */
  exportIntent?: boolean;
}

export interface CameraPresentation {
  version: 1;
  cameras: readonly AuthoredCamera[];
  activeCameraId?: string;
  policy: CameraPolicy;
}

export const EMPTY_CAMERA_PRESENTATION: CameraPresentation = {
  version: 1,
  cameras: [],
  policy: 'editor',
};

const POLICIES: Record<CameraPolicy, true> = {
  editor: true,
  'all-actors': true,
  'subject-chase': true,
  'dash-camera': true,
  authored: true,
  'auto-incident': true,
  free: true,
};

/** Tolerant at the presentation-extension boundary: malformed data cannot break a scenario. */
export function parseCameraPresentation(value: unknown): CameraPresentation {
  if (!value || typeof value !== 'object') return EMPTY_CAMERA_PRESENTATION;
  const raw = value as Record<string, unknown>;
  const cameras = Array.isArray(raw.cameras)
    ? raw.cameras.map(parseCamera).filter((camera): camera is AuthoredCamera => camera !== null)
    : [];
  // Persisted presentations used `ego-chase`; normalize it at the read boundary
  // so every newly written presentation uses the sensor-derived vocabulary.
  const policy = raw.policy === 'ego-chase'
    ? 'subject-chase'
    : typeof raw.policy === 'string' && POLICIES[raw.policy as CameraPolicy] === true
      ? raw.policy as CameraPolicy
      : 'editor';
  const active = typeof raw.activeCameraId === 'string'
    && cameras.some((camera) => camera.id === raw.activeCameraId)
    ? raw.activeCameraId
    : undefined;
  return { version: 1, cameras, policy, ...(active ? { activeCameraId: active } : {}) };
}

/** Select the stable authored view used by read-only playback. */
export function preferredAuthoredCamera(template: Pick<ScenarioTemplateV2, 'extensions'>): CameraView | null {
  const presentation = parseCameraPresentation(template.extensions?.[CAMERA_EXTENSION_KEY]);
  const camera = presentation.cameras.find((item) => item.id === presentation.activeCameraId)
    ?? presentation.cameras[0];
  if (!camera) return null;
  return { position: camera.position, target: camera.target, fov: camera.fov };
}

function parseCamera(value: unknown): AuthoredCamera | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const position = vec3(raw.position);
  const target = vec3(raw.target);
  if (typeof raw.id !== 'string' || typeof raw.name !== 'string' || !position || !target) return null;
  const fov = typeof raw.fov === 'number' && Number.isFinite(raw.fov)
    ? Math.max(10, Math.min(120, raw.fov))
    : 55;
  const attachment = parseAttachment(raw.attachment);
  return {
    id: raw.id,
    name: raw.name,
    position,
    target,
    fov,
    ...(attachment ? { attachment } : {}),
    ...(raw.exportIntent === true ? { exportIntent: true } : {}),
  };
}

function vec3(value: unknown): readonly [number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 3 || value.some((n) => typeof n !== 'number' || !Number.isFinite(n))) {
    return null;
  }
  return [value[0] as number, value[1] as number, value[2] as number];
}

function parseAttachment(value: unknown): CameraAttachment | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== 'string') return undefined;
  if (raw.kind === 'actor') return { kind: 'actor', id: raw.id };
  if (raw.kind === 'map-feature') return { kind: 'map-feature', id: raw.id };
  if (raw.kind === 'traffic-signal') {
    return {
      kind: 'traffic-signal',
      id: raw.id,
      ...(typeof raw.approach === 'string' ? { approach: raw.approach } : {}),
    };
  }
  return undefined;
}
