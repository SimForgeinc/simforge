import { useEffect, useState, type CSSProperties } from 'react';
import { Vector3 } from 'three';
import { EditorDetailsPanel } from '@uniscenarios/editor-ui';
import type { CityViewer } from '@uniscenarios/city-renderer';
import {
  physicsReasonLabel,
  type ActorPhysicsDisplay,
  type SampledActor,
} from '@uniscenarios/playback';
import {
  dashCameras,
  defaultDashCamera,
  supportsDashCamera,
  type DashCameraSensor,
  type RoleBinding,
} from '@uniscenarios/scenario-model';
import { CATALOG, getEntry, type CatalogId } from '@uniscenarios/prop-catalog';
import type { EditorController } from '../editor/controller';
import { simulationClassFor, type ActorRecord } from '../editor/document';
import { defaultSpeedKph } from '../timeline/actions';

/** Resolve any authored role into the actor-details view using its concrete preview pose. */
export function actorRecordForRole(role: RoleBinding, sampled?: SampledActor): ActorRecord | null {
  const absolute = role.kind === 'scene_absolute' ? role.pose : null;
  if (!sampled && !absolute) return null;
  const catalogId = (role.actor.catalogId ?? sampled?.catalogId) as CatalogId | undefined;
  if (!catalogId) return null;
  const dims = role.actor.dims
    ? { l: role.actor.dims.length, w: role.actor.dims.width, h: role.actor.dims.height }
    : sampled?.dims ?? getEntry(catalogId).dims;
  const actorKind: ActorRecord['kind'] = role.actor.class === 'static_object'
    ? 'prop'
    : role.actor.class === 'pedestrian' ? 'pedestrian' : 'vehicle';
  return {
    id: role.id,
    source: actorKind === 'prop' ? 'prop' : 'role',
    kind: actorKind,
    catalogId,
    label: role.label,
    x: sampled?.x ?? absolute!.position.x,
    y: absolute?.position.y ?? 0,
    z: sampled?.z ?? absolute!.position.z,
    headingRad: sampled?.headingRad ?? absolute!.headingRad,
    laneRef: undefined,
    dims,
    bodyColor: typeof role.extensions?.['studio.presentation.bodyColor'] === 'string'
      ? role.extensions['studio.presentation.bodyColor']
      : undefined,
    initialSpeedKph: typeof role.initialSpeedKph === 'number' ? role.initialSpeedKph : defaultSpeedKph(role.actor.class, catalogId),
    sensors: role.actor.sensors,
  };
}

function getEntrySafeLabel(id: CatalogId): string {
  try { return getEntry(id).label; } catch { return id; }
}

/**
 * Appearance fields shared by the anchored callout and the selection-driven
 * inspector: motion backend, catalog model, body color, default speed.
 */
export function ActorAppearanceBody({ actor, physics, controller }: {
  actor: ActorRecord;
  physics: ActorPhysicsDisplay | null;
  controller: EditorController;
}): JSX.Element {
  const known = CATALOG.some((entry) => entry.id === actor.catalogId);
  const models = CATALOG.filter((entry) => actor.kind === 'pedestrian'
    ? entry.class === 'pedestrian'
    : actor.kind === 'vehicle' ? entry.class === 'vehicle' : false);
  return <div role="tabpanel" aria-label="Appearance">
    {physics ? <div style={styles.actorPhysics} role="status" data-testid="actor-physics-backend">
      <span>Motion backend</span>
      <strong>{physics.mode === 'dynamic-v1' ? `Dynamic v1 · ${physics.profile ?? 'class profile'}` : physics.mode === 'fixed-static-v1' ? 'Fixed static' : physics.mode === 'kinematic-v1' ? 'Legacy kinematic replay' : 'Unknown'}</strong>
      <small>{physicsReasonLabel(physics.reason)}</small>
    </div> : null}
    <label style={styles.actorField}><span>Catalog model</span><select value={actor.catalogId} onChange={(event) => controller.updateActorAppearance(actor.id, { catalogId: event.target.value as CatalogId })} data-testid="actor-model">
      {!known ? <option value={actor.catalogId}>Missing model · {actor.catalogId}</option> : null}
      {models.map((entry) => {
        const cameraConflict = actor.sensors.length > 0 && !supportsDashCamera({ class: simulationClassFor(entry.id) });
        return <option key={entry.id} value={entry.id} disabled={cameraConflict}>{entry.label}{cameraConflict ? ' · remove cameras first' : ''}</option>;
      })}
    </select></label>
    {actor.kind === 'vehicle' ? <label style={styles.actorField}><span>Body color</span><span style={styles.colorControl}><input type="color" value={actor.bodyColor ?? '#59748f'} onInput={(event) => controller.updateActorAppearance(actor.id, { bodyColor: event.currentTarget.value })} data-testid="actor-body-color" /><code>{actor.bodyColor ?? '#59748f'}</code></span></label> : null}
    {actor.kind !== 'prop' ? <label style={styles.actorField}><span>Default speed</span><span><input type="number" min={0} max={200} step={1} value={Number((actor.initialSpeedKph ?? 0).toFixed(2))} onChange={(event) => controller.updateActorAppearance(actor.id, { initialSpeedKph: Number(event.currentTarget.value) })} data-testid="actor-default-speed" /> km/h</span></label> : null}
    {!known ? <div style={styles.missingAsset}>This model is unavailable in this build. Its ID is preserved until you choose a replacement.</div> : null}
    <div style={styles.actorIdentity}>The default speed applies before timeline actions. Changing actor type removes actions that do not apply to the new type.</div>
  </div>;
}

/**
 * Selection-driven right inspector: the shared EditorDetailsPanel surface
 * carrying the same appearance and sensor controls the anchored callout had.
 */
export function ActorInspectorPanel({ actor, physics, controller, onClose, onDelete }: {
  actor: ActorRecord | null;
  physics: ActorPhysicsDisplay | null;
  controller: EditorController;
  onClose: () => void;
  onDelete?: () => void;
}): JSX.Element | null {
  if (!actor) return null;
  return <EditorDetailsPanel
    ariaLabel={`${actor.kind} details`}
    testId="actor-details"
    onClose={onClose}
    onDelete={onDelete}
    preview={<span style={styles.inspectorGlyph} aria-hidden="true">{actor.kind === 'vehicle' ? '🚗' : actor.kind === 'pedestrian' ? '🚶' : '▣'}</span>}
  >
    <ActorAppearanceBody actor={actor} physics={physics} controller={controller} />
    <ActorSensorsPanel actor={actor} controller={controller} />
  </EditorDetailsPanel>;
}


/** Anchored callout kept for the viewport-attached variant of the details view. */
export function ActorDetailsCallout({ actor, physics, controller, viewer, host, onClose }: {
  actor: ActorRecord | null;
  physics: ActorPhysicsDisplay | null;
  controller: EditorController;
  viewer: CityViewer;
  host: HTMLDivElement | null;
  onClose: () => void;
}): JSX.Element | null {
  const [anchor, setAnchor] = useState({ x: 0, y: 0, panelX: 72, panelY: 16, visible: false });
  const [tab, setTab] = useState<'appearance' | 'sensors'>('appearance');
  useEffect(() => { setTab('appearance'); }, [actor?.id]);
  useEffect(() => {
    if (!actor || !host) return;
    let raf = 0;
    let previous = '';
    const update = (): void => {
      const bounds = host.getBoundingClientRect();
      const point = new Vector3(actor.x, actor.y + actor.dims.h * 0.65, actor.z).project(viewer.camera);
      const x = (point.x * 0.5 + 0.5) * bounds.width;
      const y = (-point.y * 0.5 + 0.5) * bounds.height;
      const panelX = Math.max(70, Math.min(bounds.width - 318, x + (x > bounds.width * 0.62 ? -330 : 34)));
      const panelY = Math.max(12, Math.min(bounds.height - 300, y - 86));
      const next = `${Math.round(x)}|${Math.round(y)}|${Math.round(panelX)}|${Math.round(panelY)}|${point.z < 1}`;
      if (next !== previous) {
        previous = next;
        setAnchor({ x, y, panelX, panelY, visible: point.z < 1 });
      }
      raf = requestAnimationFrame(update);
    };
    update();
    return () => cancelAnimationFrame(raf);
  }, [actor, host, viewer]);
  useEffect(() => {
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', key, { capture: true });
    return () => window.removeEventListener('keydown', key, { capture: true });
  }, [onClose]);
  if (!actor) return null;
  const lineEndX = anchor.panelX > anchor.x ? anchor.panelX : anchor.panelX + 304;
  const lineEndY = anchor.panelY + 44;
  return <>
    {anchor.visible ? <svg style={styles.actorConnector} aria-hidden="true">
      <line x1={anchor.x} y1={anchor.y} x2={lineEndX} y2={lineEndY} stroke="#f08a43" strokeWidth="1.5" />
      <circle cx={anchor.x} cy={anchor.y} r="4" fill="#f08a43" stroke="#16191e" strokeWidth="2" />
    </svg> : null}
    <aside style={{ ...styles.actorDetails, left: anchor.panelX, top: anchor.panelY }} aria-label={`${actor.kind} details`} data-testid="actor-details">
      <div style={styles.actorDetailsHeader}><div><small>{actor.kind}</small><strong>{actor.label ?? getEntrySafeLabel(actor.catalogId)}</strong></div><button type="button" onClick={onClose} aria-label="Close actor details">×</button></div>
      <div role="tablist" aria-label="Actor settings" style={styles.actorTabs}>
        <button type="button" role="tab" aria-selected={tab === 'appearance'} style={tab === 'appearance' ? styles.actorTabActive : styles.actorTab} onClick={() => setTab('appearance')}>Appearance</button>
        <button type="button" role="tab" aria-selected={tab === 'sensors'} style={tab === 'sensors' ? styles.actorTabActive : styles.actorTab} onClick={() => setTab('sensors')} data-testid="actor-sensors-tab">Sensors{actor.sensors.length ? ` · ${actor.sensors.length}` : ''}</button>
      </div>
      {tab === 'appearance'
        ? <ActorAppearanceBody actor={actor} physics={physics} controller={controller} />
        : <ActorSensorsPanel actor={actor} controller={controller} />}
    </aside>
  </>;
}

export function ActorSensorsPanel({ actor, controller }: { actor: ActorRecord; controller: EditorController }): JSX.Element {
  const role = controller.doc.data.roles.find((item) => item.id === actor.id);
  const supported = role ? supportsDashCamera(role.actor) : false;
  const cameras = dashCameras({ sensors: actor.sensors }, { includeDisabled: true });
  const addCamera = (): void => {
    if (!role || !supported) return;
    controller.doc.addActorSensor(actor.id, defaultDashCamera(role.actor));
  };
  return <div role="tabpanel" aria-label="Sensors" data-testid="actor-sensors-panel">
    <div style={styles.sensorIntro}>Sensors are mounted to this actor and move with it during playback.</div>
    {!supported ? <div style={styles.sensorUnsupported} role="status">Dash cameras are not supported on this actor type. Vehicle-mounted cameras are available for cars, trucks, buses, vans, and motorcycles.</div> : null}
    {cameras.map((camera, index) => <DashCameraEditor key={camera.id} actorId={actor.id} sensor={camera} ordinal={index + 1} controller={controller} />)}
    {supported ? <button type="button" style={styles.sensorAdd} onClick={addCamera} data-testid="add-dash-camera" aria-label={`Add dash camera to ${actor.label ?? actor.catalogId}`}>＋ Add Dash Camera</button> : null}
    {supported && cameras.length === 0 ? <div style={styles.sensorEmpty}>No cameras attached.</div> : null}
  </div>;
}

function DashCameraEditor({ actorId, sensor, ordinal, controller }: {
  actorId: string;
  sensor: DashCameraSensor;
  ordinal: number;
  controller: EditorController;
}): JSX.Element {
  const replace = (next: DashCameraSensor): void => controller.doc.updateActorSensor(actorId, sensor.id, next);
  const number = (value: string, fallback: number): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const bounded = (value: string, fallback: number, min: number, max: number): number =>
    Math.min(max, Math.max(min, number(value, fallback)));
  const position = (axis: 'x' | 'y' | 'z', value: string): void => replace({
    ...sensor,
    mount: { ...sensor.mount, position: { ...sensor.mount.position, [axis]: number(value, sensor.mount.position[axis]) } },
  });
  const angle = (axis: 'yawRad' | 'pitchRad' | 'rollRad', value: string): void => replace({
    ...sensor,
    mount: { ...sensor.mount, rotation: { ...sensor.mount.rotation, [axis]: bounded(value, sensor.mount.rotation[axis] * 180 / Math.PI, axis === 'pitchRad' ? -90 : -180, axis === 'pitchRad' ? 90 : 180) * Math.PI / 180 } },
  });
  return <section style={styles.sensorCard} aria-label={sensor.label ?? `Dash camera ${ordinal}`} data-testid="dash-camera-editor">
    <div style={styles.sensorHeader}>
      <label style={styles.sensorEnabled}><input type="checkbox" checked={sensor.enabled} onChange={(event) => replace({ ...sensor, enabled: event.currentTarget.checked })} aria-label={`Enable dash camera ${ordinal}`} /> <strong>Dash Camera</strong></label>
      <button type="button" style={styles.sensorRemove} onClick={() => controller.doc.removeActorSensor(actorId, sensor.id)} aria-label={`Remove dash camera ${ordinal}`}>Remove</button>
    </div>
    <label style={styles.actorField}><span>Name</span><input value={sensor.label ?? ''} placeholder={`Dash camera ${ordinal}`} onChange={(event) => {
      const label = event.currentTarget.value;
      const next = { ...sensor };
      if (label) next.label = label;
      else delete next.label;
      replace(next);
    }} aria-label={`Dash camera ${ordinal} name`} /></label>
    <label style={styles.actorField}><span>Horizontal field of view</span><span style={styles.sensorUnit}><input type="number" min={10} max={170} step={1} value={sensor.camera.horizontalFovDeg} onChange={(event) => replace({ ...sensor, camera: { ...sensor.camera, horizontalFovDeg: bounded(event.currentTarget.value, sensor.camera.horizontalFovDeg, 10, 170) } })} aria-label={`Dash camera ${ordinal} horizontal field of view`} /><span>°</span></span></label>
    <details style={styles.sensorAdvanced}>
      <summary>Mount &amp; camera details</summary>
      <div style={styles.sensorSectionLabel}>Position · actor-local metres</div>
      <div style={styles.sensorGrid}>
        {(['x', 'y', 'z'] as const).map((axis) => <label key={axis}><span>{axis === 'x' ? 'Forward' : axis === 'y' ? 'Up' : 'Left'}</span><input type="number" step={0.05} value={sensor.mount.position[axis]} onChange={(event) => position(axis, event.currentTarget.value)} aria-label={`Dash camera ${ordinal} mount ${axis}`} /></label>)}
      </div>
      <div style={styles.sensorSectionLabel}>Orientation · degrees</div>
      <div style={styles.sensorGrid}>
        {([['yawRad', 'Yaw'], ['pitchRad', 'Pitch'], ['rollRad', 'Roll']] as const).map(([axis, label]) => <label key={axis}><span>{label}</span><input type="number" step={1} value={Number((sensor.mount.rotation[axis] * 180 / Math.PI).toFixed(2))} onChange={(event) => angle(axis, event.currentTarget.value)} aria-label={`Dash camera ${ordinal} mount ${label.toLowerCase()}`} /></label>)}
      </div>
      <div style={styles.sensorGrid}>
        <label><span>Near · m</span><input type="number" min={0.01} max={10} step={0.01} value={sensor.camera.nearM} onChange={(event) => replace({ ...sensor, camera: { ...sensor.camera, nearM: bounded(event.currentTarget.value, sensor.camera.nearM, 0.001, Math.min(10, sensor.camera.farM - 0.001)) } })} aria-label={`Dash camera ${ordinal} near clipping distance`} /></label>
        <label><span>Far · m</span><input type="number" min={1} max={100000} step={10} value={sensor.camera.farM} onChange={(event) => replace({ ...sensor, camera: { ...sensor.camera, farM: bounded(event.currentTarget.value, sensor.camera.farM, sensor.camera.nearM + 0.001, 100000) } })} aria-label={`Dash camera ${ordinal} far clipping distance`} /></label>
        <label><span>Aspect</span><input type="number" min={0.1} max={10} step={0.01} value={sensor.camera.aspectRatio} onChange={(event) => replace({ ...sensor, camera: { ...sensor.camera, aspectRatio: bounded(event.currentTarget.value, sensor.camera.aspectRatio, 0.1, 10) } })} aria-label={`Dash camera ${ordinal} aspect ratio`} /></label>
      </div>
    </details>
  </section>;
}

const styles: Record<string, CSSProperties> = {
  inspectorGlyph: { fontSize: 22, lineHeight: 1 },
  actorConnector: { position: 'absolute', inset: 0, width: '100%', height: '100%', zIndex: 27, pointerEvents: 'none', overflow: 'visible' },
  actorDetails: { position: 'absolute', zIndex: 28, width: 304, maxHeight: 'min(620px, calc(100% - 24px))', overflowY: 'auto', boxSizing: 'border-box', padding: 12, border: '1px solid #555b65', borderRadius: 8, background: 'rgba(24,27,32,.98)', boxShadow: '0 16px 42px rgba(0,0,0,.48)', color: '#e8ebf0' },
  actorDetailsHeader: { display: 'flex', alignItems: 'flex-start', marginBottom: 12, gap: 8 },
  actorTabs: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 3, padding: 3, marginBottom: 12, borderRadius: 6, background: '#111419' },
  actorTab: { padding: '6px 7px', border: 0, borderRadius: 4, background: 'transparent', color: '#8993a1', fontSize: 10, cursor: 'pointer' },
  actorTabActive: { padding: '6px 7px', border: '1px solid #4f5967', borderRadius: 4, background: '#282d35', color: '#f0f2f5', fontSize: 10, cursor: 'pointer' },
  actorField: { display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 11, color: '#9099a7', fontSize: 10 },
  actorPhysics: { display: 'grid', gridTemplateColumns: '1fr auto', gap: '3px 8px', marginBottom: 12, padding: 9, border: '1px solid #39434a', borderRadius: 6, background: '#1c2426', color: '#96a1ae', fontSize: 10 },
  colorControl: { display: 'flex', alignItems: 'center', gap: 9, color: '#c8ced7' },
  missingAsset: { marginBottom: 9, padding: 7, borderRadius: 5, background: '#4b3523', color: '#ffd0a8', fontSize: 9 },
  actorIdentity: { paddingTop: 8, borderTop: '1px solid #393e46', color: '#747e8c', fontSize: 9, lineHeight: 1.35 },
  sensorIntro: { marginBottom: 10, color: '#929ba8', fontSize: 10, lineHeight: 1.4 },
  sensorUnsupported: { marginBottom: 10, padding: 9, border: '1px solid #574832', borderRadius: 6, background: '#312a20', color: '#e5c696', fontSize: 10, lineHeight: 1.4 },
  sensorEmpty: { marginTop: 8, color: '#737d8b', fontSize: 9, textAlign: 'center' },
  sensorAdd: { width: '100%', padding: '8px 10px', border: '1px solid #476783', borderRadius: 5, background: '#213448', color: '#d9edff', fontSize: 10, cursor: 'pointer' },
  sensorCard: { marginBottom: 10, padding: 9, border: '1px solid #414852', borderRadius: 6, background: '#20242a' },
  sensorHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 9, fontSize: 10 },
  sensorEnabled: { display: 'flex', alignItems: 'center', gap: 6, color: '#e6eaf0' },
  sensorRemove: { padding: '3px 6px', border: '1px solid #694b4b', borderRadius: 4, background: '#332526', color: '#e7adad', fontSize: 9, cursor: 'pointer' },
  sensorUnit: { display: 'grid', gridTemplateColumns: '1fr auto', alignItems: 'center', gap: 6 },
  sensorAdvanced: { color: '#a5aebb', fontSize: 10 },
  sensorSectionLabel: { marginTop: 9, marginBottom: 5, color: '#737e8c', fontSize: 8, textTransform: 'uppercase', letterSpacing: '.06em' },
  sensorGrid: { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 6, marginBottom: 7 },
};
