import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRLightsPunctual } from '@gltf-transform/extensions';
import type { InstancedMesh, Light } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { expect, it } from 'vitest';

import { buildWebTier } from '../src/web-tier.js';

it('streams rigid placements once while retaining lights, nonidentity skins, morphs and animated hierarchies', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'simforge-web-scene-'));
  try {
    const master = new Document();
    const buffer = master.createBuffer();
    const accessor = (type: 'SCALAR' | 'VEC3' | 'VEC4' | 'MAT4', array: Float32Array | Uint16Array) => master.createAccessor().setBuffer(buffer).setType(type).setArray(array);
    const positions = accessor('VEC3', new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]));
    const primitive = () => master.createPrimitive().setAttribute('POSITION', positions);
    const rigid = master.createMesh('rigid').addPrimitive(primitive());
    const scene = master.createScene('authored').setExtras({ coordinateFrame: 'map' });
    master.getRoot().setDefaultScene(scene);
    const district = master.createNode('district').setTranslation([10, 0, 20]);
    scene.addChild(district);
    district.addChild(master.createNode('Road_Main').setMesh(rigid));
    district.addChild(master.createNode('prop_a').setMesh(rigid).setTranslation([2, 0, 0]));
    district.addChild(master.createNode('prop_b').setMesh(rigid).setTranslation([4, 0, 0]));

    const lights = master.createExtension(KHRLightsPunctual);
    district.addChild(master.createNode('lamp').setTranslation([0, 8, 0])
      .setExtension('KHR_lights_punctual', lights.createLight().setType('spot').setIntensity(500)));

    const joints = Array.from({ length: 70 }, (_, index) => master.createNode(`joint_${index}`).setTranslation([0, index === 0 ? 2 : 1, 0]));
    district.addChild(joints[0]!);
    for (let index = 1; index < joints.length; index += 1) joints[index - 1]!.addChild(joints[index]!);
    const bindMatrices = new Float32Array(70 * 16);
    for (let index = 0; index < 70; index += 1) {
      bindMatrices.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -10, -(index + 2), -20, 1], index * 16);
    }
    const skin = master.createSkin('bound').setSkeleton(joints[0]!).setInverseBindMatrices(accessor('MAT4', bindMatrices));
    for (const joint of joints) skin.addJoint(joint);
    const skinnedMesh = master.createMesh('deformable');
    for (let index = 0; index < 3; index += 1) {
      skinnedMesh.addPrimitive(primitive()
        .setAttribute('JOINTS_0', accessor('VEC4', new Uint16Array([0, 0, 0, 0, 69, 0, 0, 0, 1, 0, 0, 0])))
        .setAttribute('WEIGHTS_0', accessor('VEC4', new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]))));
    }
    district.addChild(master.createNode('skinned').setMesh(skinnedMesh).setSkin(skin));
    const animatedParent = master.createNode('animated_parent').setTranslation([0, 3, 0]);
    animatedParent.addChild(master.createNode('moving_child').setMesh(rigid));
    district.addChild(animatedParent);
    const animation = master.createAnimation('move');
    const sampler = master.createAnimationSampler().setInterpolation('LINEAR')
      .setInput(accessor('SCALAR', new Float32Array([0, 1])))
      .setOutput(accessor('VEC3', new Float32Array([0, 3, 0, 0, 9, 0])));
    animation.addSampler(sampler);
    for (const target of [animatedParent, joints[0]!]) {
      animation.addChannel(master.createAnimationChannel().setTargetNode(target).setTargetPath('translation').setSampler(sampler));
    }
    const morphMesh = master.createMesh('morph').addPrimitive(primitive().addTarget(master.createPrimitiveTarget()
      .setAttribute('POSITION', accessor('VEC3', new Float32Array([0, 0, 0, 0, 2, 0, 0, 0, 0])))));
    district.addChild(master.createNode('morphing').setMesh(morphMesh).setWeights([0.5]));

    const report = await buildWebTier(master, directory);
    const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
    const manifest = JSON.parse(await readFile(path.join(directory, '3d/manifest.json'), 'utf8')) as {
      staticLayers: Array<{ file: string }>;
      tiles: Array<{ lods: Array<{ file: string }> }>;
      vegetationTiles: Array<{ lods: Array<{ file: string }> }>;
    };
    const faithful = await io.read(path.join(directory, '3d', manifest.staticLayers[0]!.file));
    const nodes = new Map(faithful.getRoot().listNodes().map((node) => [node.getName(), node]));
    expect(nodes.get('lamp')!.getExtension<Light>('KHR_lights_punctual')!.getIntensity()).toBe(500);
    expect(nodes.get('lamp')!.getWorldTranslation()).toEqual([10, 8, 20]);
    const retainedSkin = nodes.get('skinned')!.getSkin()!;
    expect(retainedSkin.listJoints().map((joint) => joint.getName())).toEqual(joints.map((joint) => joint.getName()));
    expect(Array.from(retainedSkin.getInverseBindMatrices()!.getArray()!)).toEqual(Array.from(bindMatrices));
    expect(retainedSkin.listJoints()[69]!.getWorldTranslation()).toEqual([10, 71, 20]);
    expect(nodes.get('skinned')!.getMesh()!.listPrimitives()).toHaveLength(3);
    expect(nodes.get('moving_child')!.getParentNode()).toBe(nodes.get('animated_parent'));
    expect(nodes.get('morphing')!.getWeights()).toEqual([0.5]);
    expect(nodes.get('morphing')!.getMesh()!.listPrimitives()[0]!.listTargets()[0]!.getAttribute('POSITION')!.getElement(1, [])).toEqual([0, 2, 0]);
    expect(faithful.getRoot().listAnimations()[0]!.listChannels().map((channel) => ({
      target: channel.getTargetNode()!.getName(),
      path: channel.getTargetPath(),
      values: Array.from(channel.getSampler()!.getOutput()!.getArray()!),
    }))).toEqual(['animated_parent', 'joint_0'].map((target) => ({ target, path: 'translation', values: [0, 3, 0, 0, 9, 0] })));
    expect(nodes.get('Road_Main')!.getMesh()!.listPrimitives()[0]!.getAttribute('POSITION')!.getComponentType()).toBe(5126);
    expect(nodes.get('prop_a')!.getMesh()).toBeNull();
    expect(nodes.get('prop_b')!.getMesh()).toBeNull();
    let placements = faithful.getRoot().listNodes().filter((node) => node.getMesh()).length;
    let instances = 0;
    for (const row of [...manifest.tiles, ...manifest.vegetationTiles]) {
      const tile = await io.read(path.join(directory, '3d', row.lods[0]!.file));
      for (const node of tile.getRoot().listNodes()) {
        if (!node.getMesh()) continue;
        const batch = node.getExtension<InstancedMesh>('EXT_mesh_gpu_instancing');
        const count = batch?.getAttribute('TRANSLATION')?.getCount() ?? 1;
        placements += count;
        if (batch) instances += count;
        for (const prim of node.getMesh()!.listPrimitives()) expect(prim.getAttribute('JOINTS_0')).toBeNull();
      }
    }
    expect(placements).toBe(6);
    expect(instances).toBe(2);
    expect(report.skinnedNodesFlattened).toBe(0);
    expect(report.skinnedNodesPreserved).toBe(1);
    expect(master.getRoot().listNodes().find((node) => node.getName() === 'prop_a')!.getMesh()).toBe(rigid);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
