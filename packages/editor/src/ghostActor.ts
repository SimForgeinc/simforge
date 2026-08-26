import { BufferAttribute, BufferGeometry, DoubleSide, Group, LineBasicMaterial, LineSegments, type Material, Mesh, MeshBasicMaterial } from "three";
import { getEntry, type CatalogId } from "@simforge-oss/asset-catalog";
import { propTemplate } from "@simforge-oss/viewer";
import { externalModelScene, onExternalModelChange } from "@simforge-oss/viewer";

/**
 * The translucent preview that follows the cursor during placement.
 *
 * Reuses the merged template geometry so entering placement mode costs one
 * `Group`, not a prop build — and swaps only the *material reference* on its own
 * meshes, never mutating `prop-catalog`'s shared materials.
 */
export class GhostActor {
  readonly group = new Group();

  private readonly validMaterial: MeshBasicMaterial;
  private readonly freeMaterial: MeshBasicMaterial;
  private readonly invalidMaterial: MeshBasicMaterial;
  private readonly meshes: Mesh[] = [];
  private readonly arrow: LineSegments;
  private catalogId: CatalogId | null = null;
  private outcome: 'snapped' | 'free' | 'invalid' = 'snapped';
  private readonly unsubscribeExternalModelChanges: () => void;

  constructor() {
    this.group.name = 'placement-ghost';
    this.group.visible = false;
    this.group.renderOrder = 25;
    const base = {
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
      side: DoubleSide,
      toneMapped: false,
    };
    this.validMaterial = new MeshBasicMaterial({ ...base, color: 0x35d07f });
    this.freeMaterial = new MeshBasicMaterial({ ...base, color: 0xf59e0b });
    this.invalidMaterial = new MeshBasicMaterial({ ...base, color: 0xf05252 });

    this.arrow = new LineSegments(
      new BufferGeometry(),
      new LineBasicMaterial({ color: 0xffffff, toneMapped: false, depthTest: false }),
    );
    this.arrow.renderOrder = 26;
    this.arrow.frustumCulled = false;
    this.group.add(this.arrow);
    this.unsubscribeExternalModelChanges = onExternalModelChange((contentHash) => {
      if (!this.catalogId || !externalModelScene(contentHash)) return;
      try {
        const model = getEntry(this.catalogId).model;
        if (model?.kind === 'glb' && model.contentHash === contentHash) {
          this.rebuild(this.catalogId);
        }
      } catch {
        // The gallery entry may have been unregistered while its fetch completed.
      }
    });
  }

  /** Swap the previewed prop. No-op when it is already showing. */
  show(catalogId: CatalogId): void {
    if (this.catalogId !== catalogId) {
      this.rebuild(catalogId);
      this.catalogId = catalogId;
    }
    this.group.visible = true;
  }

  hide(): void {
    this.group.visible = false;
  }

  setPose(x: number, y: number, z: number, headingRad: number): void {
    this.group.position.set(x, y, z);
    this.group.rotation.set(0, headingRad, 0);
  }

  /** Green when the placement is legal, red when it is not. */
  setValid(valid: boolean): void {
    this.setOutcome(valid ? 'snapped' : 'invalid');
  }

  /** Drop preview colour: green = will snap, amber = free, red = invalid. */
  setOutcome(outcome: 'snapped' | 'free' | 'invalid'): void {
    if (outcome === this.outcome) return;
    this.outcome = outcome;
    for (const mesh of this.meshes) mesh.material = this.material();
  }

  dispose(): void {
    this.unsubscribeExternalModelChanges();
    this.validMaterial.dispose();
    this.freeMaterial.dispose();
    this.invalidMaterial.dispose();
    this.arrow.geometry.dispose();
    (this.arrow.material as Material).dispose();
    this.group.clear();
    this.group.removeFromParent();
  }

  private rebuild(catalogId: CatalogId): void {
    for (const mesh of this.meshes) this.group.remove(mesh);
    this.meshes.length = 0;
    const template = propTemplate(catalogId);
    for (const part of template.parts) {
      const mesh = new Mesh(part.geometry, this.material());
      mesh.frustumCulled = false;
      mesh.renderOrder = 25;
      this.meshes.push(mesh);
      this.group.add(mesh);
    }
    this.setArrow(template.dims.l);
  }

  private material(): MeshBasicMaterial {
    if (this.outcome === 'invalid') return this.invalidMaterial;
    return this.outcome === 'free' ? this.freeMaterial : this.validMaterial;
  }

  /** A facing arrow on the ground, so heading is readable before the click. */
  private setArrow(length: number): void {
    const tip = Math.max(1.2, length * 0.75);
    const back = -Math.max(0.6, length * 0.35);
    const wing = 0.45;
    const y = 0.06;
    const verts = [
      back, y, 0, tip, y, 0,
      tip, y, 0, tip - wing, y, -wing,
      tip, y, 0, tip - wing, y, wing,
    ];
    this.arrow.geometry.dispose();
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(verts), 3));
    this.arrow.geometry = geometry;
  }
}
