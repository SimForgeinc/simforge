import { BoxGeometry, BufferGeometry, Float32BufferAttribute, Group, Mesh, MeshStandardMaterial } from 'three';
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_SURFACE_MATERIAL_PACK,
  SurfaceMaterialRegistry,
  classifySurface,
  geometryDigest,
} from './surface-materials';

function surface(name: string, materialName: string): Mesh {
  const material = new MeshStandardMaterial({ color: 0x777777, roughness: 0.5, metalness: 0.2 });
  material.name = materialName;
  const mesh = new Mesh(new BoxGeometry(3, 0.1, 5), material);
  mesh.name = name;
  return mesh;
}

describe('semantic surface classifier', () => {
  it.each([
    ['Roads_Road_Layer0', 'Asphalt1_Road', 'asphalt'],
    ['Terrain_Ground_Layer0', 'Grass2_rrx_Ground', 'grass'],
    ['Roads_Sidewalk_Layer0', 'Dirt1_rrx_Sidewalk', 'concrete'],
    ['Roads_Curb_Layer0', 'Concrete1_Curb', 'curb'],
    ['Roads_Marking_Layer0', 'LaneMarking1_Marking', 'marking'],
    ['TrafficCamera04', 'metal_supportArms', 'unknown'],
  ] as const)('classifies %s / %s conservatively', (meshName, materialName, expected) => {
    const mesh = surface(meshName, materialName);
    expect(classifySurface(mesh, mesh.material as MeshStandardMaterial, 'road').kind).toBe(expected);
  });

  it('always protects marking identities even when another token says asphalt', () => {
    const mesh = surface('Roads_Asphalt_Marking_Layer0', 'Asphalt1_Marking');
    expect(classifySurface(mesh, mesh.material as MeshStandardMaterial, 'road').kind).toBe('marking');
  });

  it.each([
    ['yale-street', 'Roads_Road_Layer0', 'Asphalt1_Road', 'asphalt'],
    ['belmont-research-center', 'Roads_Sidewalk_Layer0', 'Concrete4_rrx_Curb', 'curb'],
    ['el-camino-road', 'Roads_Sidewalk_Layer0', 'Grass1_Sidewalk', 'grass'],
    ['easterbrook-discovery-school', 'Roads_Layer0', 'Curb_Saratoga', 'curb'],
    ['richmond-field-station', 'Roads_Sidewalk_Layer0', 'Concrete1_Sidewalk', 'concrete'],
  ] as const)('covers audited %s semantic identities', (_map, meshName, materialName, expected) => {
    const mesh = surface(meshName, materialName);
    expect(classifySurface(mesh, mesh.material as MeshStandardMaterial, 'road').kind).toBe(expected);
  });

  it('produces a geometry digest independent of object transforms', () => {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 2, 0, 0, 0, 0, 2], 3));
    const before = geometryDigest(geometry);
    const mesh = new Mesh(geometry, new MeshStandardMaterial());
    mesh.position.set(90, 8, -17);
    mesh.rotation.set(0.2, 1.1, 0.3);
    mesh.scale.set(4, 2, 3);
    expect(geometryDigest(mesh.geometry)).toBe(before);
  });
});

describe('surface material profiles', () => {
  it('declares a self-contained pack with no third-party texture inputs', () => {
    expect(BUILTIN_SURFACE_MATERIAL_PACK.provenance.license).toBe('Apache-2.0');
    expect(BUILTIN_SURFACE_MATERIAL_PACK.provenance.externalAssets).toEqual([]);
  });

  it('is reversible and does not change geometry, transforms, or material identity', () => {
    const root = new Group();
    const road = surface('Roads_Road_Layer0', 'Asphalt1_Road');
    const marking = surface('Roads_Marking_Layer0', 'LaneMarking1_Marking');
    root.add(road, marking);
    road.position.set(8, 2, -3);
    root.updateMatrixWorld(true);
    const material = road.material as MeshStandardMaterial;
    const markingMaterial = marking.material as MeshStandardMaterial;
    const color = material.color.clone();
    const roughness = material.roughness;
    const matrix = road.matrixWorld.clone();
    const positionArray = road.geometry.getAttribute('position').array.slice();

    const registry = new SurfaceMaterialRegistry();
    registry.registerTree(root, 'road');
    const report = registry.apply('enhanced');
    expect(report.enhancedMaterials).toBe(1);
    expect(report.preservedMarkings).toBe(1);
    expect(road.material).toBe(material);
    expect(marking.material).toBe(markingMaterial);
    expect(material.roughness).toBeGreaterThan(roughness);
    expect(markingMaterial.roughness).toBe(0.5);
    expect(road.matrixWorld.equals(matrix)).toBe(true);
    expect([...road.geometry.getAttribute('position').array]).toEqual([...positionArray]);

    registry.apply('original');
    expect(material.color.equals(color)).toBe(true);
    expect(material.roughness).toBe(roughness);
    expect(road.material).toBe(material);
  });

  it('composes its shader after an existing baked-shadow patch and uses stable keys', () => {
    const root = new Group();
    const road = surface('Roads_Road_Layer0', 'Asphalt1_Road');
    const material = road.material as MeshStandardMaterial;
    material.onBeforeCompile = (shader) => {
      shader.fragmentShader = `// baked-shadow\n${shader.fragmentShader}`;
    };
    material.customProgramCacheKey = () => 'city-baked-shadow-v1';
    root.add(road);
    const registry = new SurfaceMaterialRegistry();
    registry.registerTree(root, 'road');
    registry.apply('enhanced');
    const shader = {
      uniforms: {},
      vertexShader: 'void main(){\n#include <project_vertex>\n}',
      fragmentShader: 'void main(){\n#include <map_fragment>\n}',
    };
    material.onBeforeCompile(shader as never, {} as never);
    expect(shader.fragmentShader).toContain('// baked-shadow');
    expect(shader.fragmentShader).toContain('surfaceHash');
    expect(shader.vertexShader).toContain('vSurfaceWorldPos');
    expect(material.customProgramCacheKey()).toBe('city-baked-shadow-v1|surface-enhanced-asphalt-v1');
  });

  it('reports unknowns unchanged with deterministic identity evidence', () => {
    const root = new Group();
    const unknown = surface('TrafficCamera04', 'metal_supportArms');
    root.add(unknown);
    const material = unknown.material as MeshStandardMaterial;
    const registry = new SurfaceMaterialRegistry();
    registry.registerTree(root, 'road');
    const report = registry.apply('presentation');
    expect(report.unknownMaterials).toBe(1);
    expect(report.enhancedMaterials).toBe(0);
    expect(report.unknownExamples[0]).toMatch(/TrafficCamera04.*[0-9a-f]{8}/);
    expect(material.roughness).toBe(0.5);
  });
});
