import { BoxGeometry, Mesh, MeshBasicMaterial, Object3D } from 'three';
import { describe, expect, it } from 'vitest';
import { isLowFidelityHiddenHelper, isTrafficSignalMesh, keepInRoadsOnly, LOW_FIDELITY_HIDDEN_ROLE } from './roads-only';

describe('Roads Only classification', () => {
  it('keeps map-scale road sheets and drops small unknown furniture', () => {
    expect(keepInRoadsOnly(new Mesh(new BoxGeometry(50, 0.1, 50), new MeshBasicMaterial()))).toBe(true);
    expect(keepInRoadsOnly(new Mesh(new BoxGeometry(1, 3, 1), new MeshBasicMaterial()))).toBe(false);
  });

  it('keeps traffic signals using metadata first and the legacy name fallback', () => {
    const metadata = new Mesh(new BoxGeometry(0.3, 3, 0.3), new MeshBasicMaterial());
    metadata.userData.category = 'traffic_signal';
    const legacy = new Mesh(new BoxGeometry(0.3, 3, 0.3), new MeshBasicMaterial());
    legacy.name = 'Signal_3Light_Post01_mesh';
    expect(isTrafficSignalMesh(metadata)).toBe(true);
    expect(isTrafficSignalMesh(legacy)).toBe(true);
    expect(keepInRoadsOnly(metadata)).toBe(true);
    expect(keepInRoadsOnly(legacy)).toBe(true);
  });

  it('recognizes only explicitly tagged editor helpers', () => {
    const helper = new Object3D();
    helper.userData.uniscenariosRole = LOW_FIDELITY_HIDDEN_ROLE;
    expect(isLowFidelityHiddenHelper(helper)).toBe(true);
    expect(isLowFidelityHiddenHelper(new Object3D())).toBe(false);
  });
});
