import type { CameraView, CityViewer } from '../index.js';
import { newTemplateId } from '@simforge-oss/scenario';
import { AuthoredCameraHelpers } from './helpers';
import {
  CAMERA_EXTENSION_KEY,
  EMPTY_CAMERA_PRESENTATION,
  parseCameraPresentation,
  type AuthoredCamera,
  type CameraAttachment,
  type CameraPolicy,
  type CameraPresentation,
} from './model';

export interface CameraPresentationStore {
  readonly data: { extensions?: Readonly<Record<string, unknown>> };
  setPresentationExtension(key: string, value?: unknown): void;
  subscribe(listener: () => void): () => void;
}

export interface ResolvedAttachment {
  position: readonly [number, number, number];
  target?: readonly [number, number, number];
  headingRad?: number;
}

export type CameraAttachmentResolver = (attachment: CameraAttachment) => ResolvedAttachment | null;

export interface CameraRegistryOptions {
  viewer: CityViewer;
  store: CameraPresentationStore;
  resolveAttachment?: CameraAttachmentResolver;
}

/** Persistent, undoable authored-camera registry with no simulation-model ownership. */
export class CameraRegistry {
  readonly helpers = new AuthoredCameraHelpers();
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribe: () => void;
  private snapshot: CameraPresentation;

  constructor(private readonly options: CameraRegistryOptions) {
    this.snapshot = this.read();
    this.options.viewer.scene.add(this.helpers.group);
    this.helpers.sync(this.snapshot.cameras, this.snapshot.activeCameraId);
    this.unsubscribe = options.store.subscribe(() => {
      this.snapshot = this.read();
      this.helpers.sync(this.snapshot.cameras, this.snapshot.activeCameraId);
      this.emit();
    });
  }

  get state(): CameraPresentation { return this.snapshot; }
  getSnapshot = (): CameraPresentation => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  addFromCurrent(name = this.nextName(), attachment?: CameraAttachment): string {
    return this.addView(this.options.viewer.controls.getView(), name, attachment);
  }

  addView(view: CameraView, name = this.nextName(), attachment?: CameraAttachment): string {
    const id = newTemplateId('camera');
    const camera: AuthoredCamera = { id, name, ...view, ...(attachment ? { attachment } : {}) };
    this.write({ ...this.snapshot, cameras: [...this.snapshot.cameras, camera], activeCameraId: id, policy: 'authored' });
    return id;
  }

  addTrafficLightCamera(signalId: string, approach?: string): string {
    const attachment: CameraAttachment = { kind: 'traffic-signal', id: signalId, ...(approach ? { approach } : {}) };
    const resolved = this.options.resolveAttachment?.(attachment);
    if (!resolved) return this.addFromCurrent(`Signal ${signalId}`, attachment);
    const target = resolved.target ?? resolved.position;
    const heading = resolved.headingRad ?? 0;
    const position: readonly [number, number, number] = [
      resolved.position[0] - Math.cos(heading) * 1.25,
      resolved.position[1] + 2.8,
      resolved.position[2] + Math.sin(heading) * 1.25,
    ];
    return this.addView({ position, target: [target[0], target[1] + 1, target[2]], fov: 48 }, `Signal ${signalId}`, attachment);
  }

  rename(id: string, name: string): void { this.patch(id, { name: name.trim() || 'Camera' }); }
  updateFromCurrent(id: string): void { this.patch(id, this.options.viewer.controls.getView()); }
  setAttachment(id: string, attachment?: CameraAttachment): void { this.patch(id, { attachment }); }
  setExportIntent(id: string, exportIntent: boolean): void { this.patch(id, { exportIntent }); }

  duplicate(id: string): string | null {
    const source = this.snapshot.cameras.find((camera) => camera.id === id);
    if (!source) return null;
    const copyId = newTemplateId('camera');
    const copy: AuthoredCamera = { ...source, id: copyId, name: `${source.name} copy` };
    this.write({ ...this.snapshot, cameras: [...this.snapshot.cameras, copy], activeCameraId: copyId });
    return copyId;
  }

  remove(id: string): void {
    const cameras = this.snapshot.cameras.filter((camera) => camera.id !== id);
    const activeCameraId = this.snapshot.activeCameraId === id ? cameras[0]?.id : this.snapshot.activeCameraId;
    this.write({ ...this.snapshot, cameras, ...(activeCameraId ? { activeCameraId } : {}) });
  }

  activate(id: string): boolean {
    const stored = this.snapshot.cameras.find((camera) => camera.id === id);
    if (!stored) return false;
    this.options.viewer.controls.applyView(this.resolveView(stored));
    this.write({ ...this.snapshot, activeCameraId: id, policy: 'authored' });
    return true;
  }

  setPolicy(policy: CameraPolicy): void { this.write({ ...this.snapshot, policy }); }

  dispose(): void {
    this.unsubscribe();
    this.helpers.dispose();
    this.listeners.clear();
  }

  private resolveView(camera: AuthoredCamera): CameraView {
    if (!camera.attachment) return camera;
    const resolved = this.options.resolveAttachment?.(camera.attachment);
    if (!resolved) return camera;
    const offset: readonly [number, number, number] = [
      camera.position[0] - camera.target[0],
      camera.position[1] - camera.target[1],
      camera.position[2] - camera.target[2],
    ];
    const target = resolved.target ?? resolved.position;
    return {
      position: [target[0] + offset[0], target[1] + offset[1], target[2] + offset[2]],
      target,
      fov: camera.fov,
    };
  }

  private patch(id: string, update: Partial<AuthoredCamera>): void {
    this.write({
      ...this.snapshot,
      cameras: this.snapshot.cameras.map((camera) => camera.id === id ? { ...camera, ...update, id } : camera),
    });
  }
  private nextName(): string { return `Camera ${this.snapshot.cameras.length + 1}`; }
  private read(): CameraPresentation {
    return parseCameraPresentation(this.options.store.data.extensions?.[CAMERA_EXTENSION_KEY] ?? EMPTY_CAMERA_PRESENTATION);
  }
  private write(next: CameraPresentation): void { this.options.store.setPresentationExtension(CAMERA_EXTENSION_KEY, next); }
  private emit(): void { for (const listener of [...this.listeners]) listener(); }
}
