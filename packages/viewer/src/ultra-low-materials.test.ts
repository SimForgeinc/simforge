import { BoxGeometry, Color, DoubleSide, Mesh, MeshStandardMaterial } from 'three';
import { describe, expect, it } from 'vitest';
import { classifyUltraLowColor, UltraLowMaterialCache } from './ultra-low-materials';
import { LOW_FIDELITY_HIDDEN_ROLE } from './roads-only';

describe('UltraLowMaterialCache', () => {
  it('retains authored colors and caches equivalent unlit materials', () => {
    const cache = new UltraLowMaterialCache();
    const first = new Mesh(new BoxGeometry(), new MeshStandardMaterial({ color: 0x336699 }));
    const second = new Mesh(new BoxGeometry(), new MeshStandardMaterial({ color: 0x336699 }));
    const a = cache.materialFor(first, first.material, 'actor');
    const b = cache.materialFor(second, second.material, 'actor');
    expect(a).toBe(b);
    expect(a.color.getHex()).toBe(new Color(0x336699).getHex());
    expect(a.map).toBeNull();
  });

  it('preserves opacity, alpha test, double-sidedness, and vertex color use', () => {
    const geometry = new BoxGeometry();
    geometry.setAttribute('color', geometry.getAttribute('position').clone());
    const source = new MeshStandardMaterial({ opacity: 0.7, transparent: true, alphaTest: 0.4, side: DoubleSide });
    const material = new UltraLowMaterialCache().materialFor(new Mesh(geometry, source), source, 'vegetation');
    expect(material.opacity).toBe(0.7);
    expect(material.alphaTest).toBe(0.4);
    expect(material.side).toBe(DoubleSide);
    expect(material.vertexColors).toBe(true);
    expect(material.map).toBeNull();
  });

  it('uses subdued semantic colors for unbaked white map materials', () => {
    const white = new MeshStandardMaterial({ color: 0xffffff });
    white.name = 'Asphalt1_Road';
    const mesh = new Mesh(new BoxGeometry(), white);
    const material = new UltraLowMaterialCache().materialFor(mesh, white, 'road');
    expect(material.color.getHex()).toBe(classifyUltraLowColor(white.name, 'road').getHex());
    expect(material.color.getHex()).not.toBe(0xffffff);
  });

  it('trusts a baked representative color even when it is white', () => {
    const source = new MeshStandardMaterial({ color: 0xffffff });
    source.userData.uniscenariosGeometryOnly = { version: 2 };
    const material = new UltraLowMaterialCache().materialFor(new Mesh(new BoxGeometry(), source), source, 'city');
    expect(material.color.getHex()).toBe(0xffffff);
  });

  it('never turns a tagged transparent contact-shadow quad into an opaque plate', () => {
    const source = new MeshStandardMaterial({ transparent: true, opacity: 0.55 });
    const shadow = new Mesh(new BoxGeometry(), source);
    shadow.userData.uniscenariosRole = LOW_FIDELITY_HIDDEN_ROLE;
    const originals = new Map();
    new UltraLowMaterialCache().apply(shadow, 'actor', originals);
    expect(shadow.material).toBe(source);
    expect(originals.size).toBe(0);
    expect(source.transparent).toBe(true);
  });
});
