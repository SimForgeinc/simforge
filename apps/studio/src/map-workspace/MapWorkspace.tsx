import { useEffect, useState, useSyncExternalStore } from 'react';
import type { CSSProperties } from 'react';
import type { CityViewer } from '@uniscenarios/city-renderer';
import type { EditorController, EditorState } from '../editor/controller';
import type { MapEntry } from '../maps';
import type { MapOverlayHandle } from '../mapOverlays';
import { anchorFailure, parseRoadLaneRef, type MapFeatureSummary } from './model';
import { SemanticMapController } from './SemanticMapController';

export function MapWorkspace({
  viewer,
  map,
  overlays,
  editor,
  editorState,
}: {
  viewer: CityViewer | null;
  map: MapEntry;
  overlays: MapOverlayHandle | null;
  editor: EditorController | null;
  editorState: EditorState | null;
}): JSX.Element {
  const [controller, setController] = useState<SemanticMapController | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    if (!viewer) { setController(null); return; }
    const next = new SemanticMapController(viewer, map, overlays);
    setController(next);
    return () => { next.dispose(); setController((current) => current === next ? null : current); };
  }, [viewer, map, overlays]);

  const state = useSyncExternalStore(
    controller?.subscribe ?? (() => () => undefined),
    controller?.getSnapshot ?? EMPTY_STORE.getSnapshot,
  );
  const selectedActorCount = editorState?.selection.length ?? 0;
  const failure = anchorFailure(state.selected, selectedActorCount);

  const useAnchor = (feature: MapFeatureSummary): void => {
    const reason = anchorFailure(feature, selectedActorCount);
    if (reason) { setMessage(reason); return; }
    const selectedId = editorState!.selection[0]!;
    const actor = editor!.doc.actor(selectedId);
    const parsed = parseRoadLaneRef(feature.binding.rsl!);
    if (!actor || !parsed) { setMessage('The selected actor or road binding is no longer available.'); return; }
    if (actor.kind === 'vehicle' && !['driving', 'parking', 'bidirectional'].includes(feature.binding.laneType ?? '')) {
      setMessage(`A vehicle cannot use a ${feature.binding.laneType ?? 'non-road'} anchor.`);
      return;
    }
    if (actor.kind === 'pedestrian' && feature.binding.laneType !== 'sidewalk') {
      setMessage(`A pedestrian cannot use a ${feature.binding.laneType ?? 'non-walking'} anchor.`);
      return;
    }
    editor!.doc.update([{
      id: actor.id,
      x: feature.position[0], y: feature.position[1] - 0.08, z: feature.position[2],
      headingRad: feature.binding.headingRad!,
      laneRef: {
        roadId: parsed.roadId, section: parsed.section, laneId: parsed.laneId,
        s: feature.binding.s!, t: feature.binding.offsetM ?? 0, headingOffsetRad: 0,
      },
    }]);
    setMessage(`${actor.label ?? actor.catalogId} anchored to ${feature.name}.`);
  };

  return (
    <div style={styles.workspace} data-testid="map-workspace">
      <aside style={styles.browser} aria-label="Map layer browser">
        <div style={styles.panelHeader}>
          <div><div style={styles.eyebrow}>Map intelligence</div><div style={styles.title}>Semantic layers</div></div>
          <span style={styles.revision}>{state.manifest ? `rev ${state.manifest.catalogRevision.slice(0, 8)}` : 'loading'}</span>
        </div>
        <label className="studio-field" style={styles.searchWrap}>
          <span aria-hidden="true">⌕</span>
          <input
            type="search"
            aria-label="Search map features"
            placeholder="Search lanes, spaces, signals…"
            value={state.query}
            onChange={(event) => controller?.search(event.target.value)}
            style={styles.search}
          />
        </label>
        {state.status === 'error' ? <div role="alert" style={styles.error}>{state.error}</div> : null}
        <div style={styles.layerList}>
          {state.layers.map((layer) => (
            <div
              key={layer.id}
              data-testid={`map-layer-${layer.id}`}
              style={{ ...styles.layerRow, ...(!layer.available ? styles.unavailable : null) }}
              onClick={() => layer.available && controller?.revealLayer(layer.id)}
            >
              <span style={{ ...styles.swatch, background: `#${layer.color.toString(16).padStart(6, '0')}` }} />
              <span style={styles.layerIdentity}><strong>{layer.label}</strong><small>{layer.available ? layer.source : `${layer.source} · unavailable`}</small></span>
              <span style={styles.count}>{state.status === 'loading' ? '…' : layer.count}</span>
              <button
                type="button"
                aria-label={`${layer.visible ? 'Hide' : 'Show'} ${layer.label}`}
                aria-pressed={layer.visible}
                disabled={!layer.available}
                style={{ ...styles.eye, ...(layer.visible ? styles.eyeOn : null) }}
                className="studio-btn"
                onClick={(event) => { event.stopPropagation(); controller?.setVisible(layer.id, !layer.visible); }}
              >{layer.visible ? '●' : '○'}</button>
            </div>
          ))}
        </div>
        {state.query.trim() ? (
          <section style={styles.results}>
            <div style={styles.sectionTitle}>{state.resultCount} matches</div>
            {state.results.map((feature) => (
              <button key={feature.id} type="button" className="studio-btn" style={styles.result} onClick={() => { controller?.setVisible(feature.layerId, true); controller?.select(feature.id); }}>
                <span>{feature.name}</span><small>{feature.sourceRef}</small>
              </button>
            ))}
            {state.resultCount > state.results.length ? <div style={styles.more}>Showing first {state.results.length}. Refine your search.</div> : null}
          </section>
        ) : null}
        <footer style={styles.manifest}>
          <span>{state.manifest?.mapAssetId ?? map.id}</span>
          <span>{state.manifest ? `${Object.keys(state.manifest.sourceHashes).length} verified sources` : 'Reading sidecars…'}</span>
        </footer>
      </aside>

      {state.hoverStack.length > 0 ? (
        <div style={styles.hover} data-testid="map-hover-stack">
          <strong>{state.hoverStack[0]!.name}</strong>
          {state.hoverStack.length > 1 ? <span>+{state.hoverStack.length - 1} overlapping</span> : null}
        </div>
      ) : null}

      <aside style={styles.inspector} aria-label="Map feature inspector">
        {state.selected ? (
          <>
            <div style={styles.panelHeader}>
              <div><div style={styles.eyebrow}>{state.selected.layerId.replaceAll('-', ' ')}</div><div style={styles.title}>{state.selected.name}</div></div>
              <button type="button" style={styles.close} aria-label="Clear selected map feature" onClick={() => controller?.select(null)}>×</button>
            </div>
            <div style={styles.identity}>{state.selected.id}</div>
            <Section title="Binding">
              <Fact label="Quality" value={state.selected.binding.quality} tone={state.selected.binding.quality === 'exact' ? 'good' : 'warn'} />
              <Fact label="Road lane" value={state.selected.binding.rsl ?? 'Not bound'} />
              <Fact label="Travel s" value={state.selected.binding.s === null ? '—' : `${state.selected.binding.s.toFixed(2)} m`} />
              <Fact label="Lane type" value={state.selected.binding.laneType ?? '—'} />
            </Section>
            <Section title="Metadata">
              {Object.entries(state.selected.facts).slice(0, 12).map(([key, value]) => <Fact key={key} label={key.replaceAll('_', ' ')} value={String(value)} />)}
            </Section>
            <Section title="Provenance">
              {state.selected.provenance.length ? state.selected.provenance.map((entry, index) => (
                <div key={`${entry.source}:${entry.ref}:${index}`} style={styles.provenance}>
                  <strong>{entry.source}</strong><span>{entry.ref}</span><small>{Math.round(entry.confidence * 100)}% confidence</small>
                </div>
              )) : <div style={styles.empty}>No provenance rows supplied.</div>}
            </Section>
            <button
              type="button"
              data-testid="use-map-anchor"
              disabled={failure !== null}
              title={failure ?? 'Move the selected actor to this exact binding'}
              style={{ ...styles.anchorButton, ...(failure ? styles.anchorDisabled : null) }}
              className="studio-btn"
              onClick={() => useAnchor(state.selected!)}
            >Use as anchor</button>
            {failure ? <div style={styles.explanation}>{failure}</div> : null}
            {message ? <div role="status" style={styles.message}>{message}</div> : null}
          </>
        ) : (
          <div style={styles.emptyInspector}>
            <span style={styles.emptyIcon}>⌖</span><strong>Select a map feature</strong>
            <span>Choose a layer or click a highlighted feature. The viewport will never move automatically.</span>
          </div>
        )}
      </aside>
    </div>
  );
}

const EMPTY_STATE = {
  status: 'loading' as const, error: null, manifest: null, layers: [], selected: null, hoverStack: [],
  query: '', results: [], resultCount: 0, overlayObjects: 0,
};
const EMPTY_STORE = { getSnapshot: () => EMPTY_STATE };

function Section({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return <section style={styles.section}><div style={styles.sectionTitle}>{title}</div>{children}</section>;
}

function Fact({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'warn' }): JSX.Element {
  return <div style={styles.fact}><span>{label}</span><strong style={tone === 'good' ? styles.good : tone === 'warn' ? styles.warn : undefined}>{value}</strong></div>;
}

const GLASS_SURFACE: CSSProperties = {
  background: 'linear-gradient(180deg, var(--ueui-glass-high, rgba(19, 24, 32, 0.92)), var(--ueui-glass-low, rgba(8, 11, 16, 0.94)))',
  backdropFilter: 'blur(72px) saturate(185%)',
  WebkitBackdropFilter: 'blur(72px) saturate(185%)',
};

const PANEL: CSSProperties = { ...GLASS_SURFACE, border: '1px solid var(--ueui-line-strong, rgba(255,255,255,.14))', borderRadius: 'var(--ueui-radius, 10px)', boxShadow: 'var(--ueui-shadow, 0 18px 48px rgba(0,0,0,.55))', color: 'var(--ueui-text, #f2f2f2)' };
const styles: Record<string, CSSProperties> = {
  workspace: { position: 'absolute', inset: 0, zIndex: 18, pointerEvents: 'none' },
  browser: { ...PANEL, pointerEvents: 'auto', position: 'absolute', top: 12, left: 12, bottom: 12, width: 324, display: 'flex', flexDirection: 'column', overflow: 'hidden' },
  inspector: { ...PANEL, pointerEvents: 'auto', position: 'absolute', top: 12, right: 12, bottom: 12, width: 330, overflowY: 'auto', paddingBottom: 14 },
  panelHeader: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, padding: '14px 14px 10px' },
  eyebrow: { color: 'var(--ueui-accent, #e8e044)', fontSize: 9, fontWeight: 700, letterSpacing: .8, textTransform: 'uppercase' },
  title: { color: 'var(--ueui-text, #f2f2f2)', fontSize: 16, fontWeight: 650, lineHeight: 1.25 },
  revision: { color: 'var(--ueui-text-muted, #9a9a9a)', fontSize: 9, fontFamily: 'ui-monospace, monospace' },
  searchWrap: { display: 'flex', alignItems: 'center', gap: 7, margin: '0 12px 10px', padding: '0 9px', minHeight: 34 },
  search: { minWidth: 0, flex: 1, border: 0, outline: 0, background: 'transparent', color: 'var(--ueui-text, #f2f2f2)', font: 'inherit', fontSize: 11 },
  error: { margin: '0 12px 10px', padding: 9, borderRadius: 7, color: 'var(--ueui-danger, #ff6b5e)', background: 'rgba(255,107,94,.12)', fontSize: 10 },
  layerList: { overflowY: 'auto', padding: '0 8px' },
  layerRow: { display: 'flex', alignItems: 'center', gap: 9, minHeight: 48, padding: '0 7px', borderBottom: '1px solid var(--ueui-line, rgba(255,255,255,.08))', cursor: 'pointer' },
  unavailable: { opacity: .45, cursor: 'default' },
  swatch: { width: 9, height: 24, borderRadius: 3, boxShadow: '0 0 10px currentColor' },
  layerIdentity: { minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column' },
  count: { minWidth: 28, textAlign: 'right', color: 'var(--ueui-text-muted, #9a9a9a)', fontVariantNumeric: 'tabular-nums', fontSize: 10 },
  eye: { width: 27, height: 27, padding: 0, border: '1px solid var(--ueui-line, rgba(255,255,255,.08))', borderRadius: 6, background: 'rgba(255,255,255,.04)', color: 'var(--ueui-text-muted, #9a9a9a)', cursor: 'pointer' },
  eyeOn: { color: 'var(--ueui-accent, #e8e044)', borderColor: 'rgba(232,224,68,.5)', background: 'var(--ueui-accent-soft, rgba(232,224,68,.16))' },
  results: { minHeight: 0, overflowY: 'auto', padding: '10px 12px', borderTop: '1px solid var(--ueui-line, rgba(255,255,255,.08))' },
  sectionTitle: { marginBottom: 6, color: 'var(--ueui-text-muted, #9a9a9a)', fontSize: 9, fontWeight: 650, letterSpacing: .7, textTransform: 'uppercase' },
  result: { display: 'flex', width: '100%', flexDirection: 'column', gap: 1, padding: '7px 8px', border: 0, borderBottom: '1px solid var(--ueui-line, rgba(255,255,255,.08))', background: 'transparent', color: 'var(--ueui-text, #f2f2f2)', textAlign: 'left', cursor: 'pointer', font: 'inherit', fontSize: 10 },
  more: { padding: 8, color: 'var(--ueui-text-muted, #9a9a9a)', fontSize: 9 },
  manifest: { marginTop: 'auto', display: 'flex', justifyContent: 'space-between', padding: '9px 12px', borderTop: '1px solid var(--ueui-line, rgba(255,255,255,.08))', color: 'var(--ueui-text-muted, #9a9a9a)', fontSize: 8, fontFamily: 'ui-monospace, monospace' },
  hover: { ...PANEL, pointerEvents: 'none', position: 'absolute', left: '50%', bottom: 26, transform: 'translateX(-50%)', display: 'flex', gap: 9, padding: '7px 10px', fontSize: 10 },
  close: { border: 0, background: 'transparent', color: 'var(--ueui-text-muted, #9a9a9a)', cursor: 'pointer', fontSize: 18 },
  identity: { margin: '0 14px 12px', padding: '6px 8px', overflow: 'hidden', textOverflow: 'ellipsis', borderRadius: 6, background: 'rgba(8, 11, 16, 0.55)', color: 'var(--ueui-text-muted, #9a9a9a)', font: '9px ui-monospace, monospace' },
  section: { margin: '0 14px 15px', paddingTop: 10, borderTop: '1px solid var(--ueui-line, rgba(255,255,255,.08))' },
  fact: { display: 'flex', justifyContent: 'space-between', gap: 12, padding: '3px 0', color: 'var(--ueui-text-muted, #9a9a9a)', fontSize: 10 },
  good: { color: 'var(--ueui-ok, #57c785)' }, warn: { color: 'var(--ueui-warn, #f0a13c)' },
  provenance: { display: 'flex', flexDirection: 'column', gap: 1, padding: '5px 0', color: 'rgba(242,242,242,.82)', fontSize: 9 },
  empty: { color: 'var(--ueui-text-muted, #9a9a9a)', fontSize: 10 },
  anchorButton: { display: 'block', width: 'calc(100% - 28px)', margin: '4px 14px', padding: '9px 10px', border: '1px solid transparent', borderRadius: 8, background: 'var(--ueui-accent, #e8e044)', color: '#10120a', font: 'inherit', fontWeight: 700, cursor: 'pointer' },
  anchorDisabled: { borderColor: 'var(--ueui-line, rgba(255,255,255,.08))', background: 'rgba(255,255,255,.04)', color: 'var(--ueui-text-muted, #9a9a9a)', cursor: 'not-allowed' },
  explanation: { margin: '6px 14px 0', color: 'var(--ueui-text-muted, #9a9a9a)', fontSize: 9, lineHeight: 1.4 },
  message: { margin: '8px 14px 0', padding: 8, borderRadius: 6, background: 'rgba(87,199,133,.12)', color: 'var(--ueui-ok, #57c785)', fontSize: 9 },
  emptyInspector: { height: '100%', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 7, padding: 38, color: 'var(--ueui-text-muted, #9a9a9a)', textAlign: 'center', fontSize: 10 },
  emptyIcon: { color: 'var(--ueui-accent, #e8e044)', fontSize: 30 },
};
