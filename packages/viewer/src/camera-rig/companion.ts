import type { CameraPresentation } from './model';

export interface CameraCompanionMetadata {
  schema: 'simforge-camera-companion/1';
  scenarioInputHash?: string;
  presentation: CameraPresentation;
  notice: string;
}

/** Presentation sidecar for renderers; never a claim of native ASAM camera support. */
export function createCameraCompanion(
  presentation: CameraPresentation,
  scenarioInputHash?: string,
): CameraCompanionMetadata {
  return {
    schema: 'simforge-camera-companion/1',
    ...(scenarioInputHash ? { scenarioInputHash } : {}),
    presentation,
    notice: 'Presentation metadata only; not a native ASAM OpenSCENARIO camera declaration.',
  };
}
