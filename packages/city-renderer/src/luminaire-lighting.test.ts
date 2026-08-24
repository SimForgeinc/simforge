import { BoxGeometry, Group, Mesh, MeshBasicMaterial, PerspectiveCamera } from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import { isLuminaireObjectName, LuminaireLightingController } from './luminaire-lighting';

const controllers: LuminaireLightingController[] = [];
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose();
});

function fixture(name: string, x: number): Group {
  const root = new Group();
  const lamp = new Mesh(new BoxGeometry(0.4, 6, 0.4), new MeshBasicMaterial());
  lamp.name = name;
  lamp.position.set(x, 3, 0);
  root.add(lamp);
  return root;
}

describe('luminaire lighting', () => {
  it('recognises explicit street-furniture names without treating traffic lights as lamps', () => {
    expect(isLuminaireObjectName('Stanford_Street_Light_12')).toBe(true);
    expect(isLuminaireObjectName('lamp-post.4')).toBe(true);
    expect(isLuminaireObjectName('traffic_light_head_4')).toBe(false);
    expect(isLuminaireObjectName('building_lighting_bake')).toBe(false);
  });

  it('recognises UUID-glued Datasmith actor names via camel boundaries', () => {
    expect(isLuminaireObjectName('a70aaa6b-6ce4-475f-a4a7-f37a4ed1054bStreetLight_30ft_DefaultSceneRoot')).toBe(true);
    expect(isLuminaireObjectName('Luminaire_Arm_8ft_DefaultSceneRoot')).toBe(true);
    expect(isLuminaireObjectName('spotLight3_spotLight3_light')).toBe(false);
    expect(isLuminaireObjectName('Small_Electric_Pannel_01_84_StaticMeshComponent')).toBe(false);
  });

  it('counts a Datasmith street light once and anchors the bulb at its named head', () => {
    const controller = new LuminaireLightingController(2);
    controllers.push(controller);

    const actor = new Group();
    actor.name = 'a70aaa6b-6ce4-475f-a4a7-f37a4ed1054bStreetLight_30ft_DefaultSceneRoot';
    const pole = new Mesh(new BoxGeometry(0.4, 9, 0.4), new MeshBasicMaterial());
    pole.name = 'signal_post_30_mesh_StaticMeshComponent0';
    pole.position.set(0, 4.5, 0);
    const head = new Group();
    head.name = 'Luminaire_Head01_DefaultSceneRoot';
    const headMesh = new Mesh(new BoxGeometry(0.6, 0.3, 0.3), new MeshBasicMaterial());
    headMesh.name = 'Luminaire_Head01_mesh_StaticMeshComponent0';
    headMesh.position.set(2, 8.5, 0);
    head.add(headMesh);
    actor.add(pole, head);
    const root = new Group();
    root.add(actor);

    controller.registerTree(root);
    controller.setEnabled(true);
    controller.update(new PerspectiveCamera());

    expect(controller.stats()).toEqual({ discovered: 1, active: 1, enabled: true });
    const active = controller.group.children.find((child) => child.visible)!;
    expect(active.position.x).toBeCloseTo(2);
    expect(active.position.y).toBeCloseTo(8.5);
  });

  it('discovers fixtures but activates only the bounded nearest visible pool', () => {
    const controller = new LuminaireLightingController(2);
    controllers.push(controller);
    const root = new Group();
    root.add(fixture('street_light_30', 30), fixture('street_light_5', 5), fixture('street_light_12', 12));
    controller.registerTree(root);
    controller.setEnabled(true);
    const camera = new PerspectiveCamera();
    controller.update(camera);

    expect(controller.stats()).toEqual({ discovered: 3, active: 2, enabled: true });
    expect(controller.group.children.filter((child) => child.visible).map((child) => child.position.x))
      .toEqual([5, 12]);

    root.visible = false;
    controller.update(camera);
    expect(controller.stats().active).toBe(0);
  });

  it('drops evicted tile roots and disables every practical light', () => {
    const controller = new LuminaireLightingController(1);
    controllers.push(controller);
    const root = fixture('road-light-1', 2);
    controller.registerTree(root);
    controller.setEnabled(true);
    controller.update(new PerspectiveCamera());
    expect(controller.stats().active).toBe(1);

    controller.unregisterTree(root);
    controller.update(new PerspectiveCamera());
    expect(controller.stats()).toEqual({ discovered: 0, active: 0, enabled: true });
  });
});
