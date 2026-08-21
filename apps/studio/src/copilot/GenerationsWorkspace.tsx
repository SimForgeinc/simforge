import { useEffect, useMemo, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { fetchCopilotHistory } from './client';
import type { CopilotGenerationHistoryEntry } from './historyTypes';
import { TemplateDocument, type ScenarioTemplateV2 } from '@uniscenarios/scenario-model';

export interface GenerationsWorkspaceProps {
  readonly currentMapId: string;
  readonly currentMapHash: string | null;
  readonly onOpenDraft: (entry: CopilotGenerationHistoryEntry) => void;
  readonly onSwitchMap: (entry: CopilotGenerationHistoryEntry) => void;
  readonly onClose: () => void;
}

export function GenerationsWorkspace({ currentMapId, currentMapHash, onOpenDraft, onSwitchMap, onClose }: GenerationsWorkspaceProps): JSX.Element {
  const [entries, setEntries] = useState<readonly CopilotGenerationHistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [method, setMethod] = useState('all');
  const [status, setStatus] = useState('all');
  const [mapFilter, setMapFilter] = useState('all');
  const [details, setDetails] = useState<CopilotGenerationHistoryEntry | null>(null);

  const load = (): void => {
    setError(null);
    void fetchCopilotHistory().then((result) => setEntries(result.entries.filter(hasExactDraft))).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason));
      setEntries([]);
    });
  };
  useEffect(load, []);

  const methods = useMemo(() => [...new Set((entries ?? []).map((entry) => entry.provider))].sort(), [entries]);
  const maps = useMemo(() => [...new Set((entries ?? []).map((entry) => entry.mapId))].sort(), [entries]);
  const visible = useMemo(() => (entries ?? []).filter((entry) => {
    const needle = query.trim().toLowerCase();
    if (method !== 'all' && entry.provider !== method) return false;
    if (mapFilter !== 'all' && entry.mapId !== mapFilter) return false;
    if (status === 'verified' && entry.simulationPass !== true) return false;
    if (status === 'matches' && entry.semanticPass !== true) return false;
    if (status === 'needs-review' && entry.semanticPass !== false) return false;
    return !needle || `${entry.caseTitle} ${entry.prompt} ${entry.mapId} ${entry.provider} ${entry.actualModel ?? entry.requestedModel ?? ''}`.toLowerCase().includes(needle);
  }), [entries, mapFilter, method, query, status]);

  return <section style={styles.workspace} aria-label="Scenario generations" data-testid="generations-workspace">
    <header style={styles.header}>
      <div><div style={styles.eyebrow}>SAVED NATIVE DRAFTS</div><h1 style={styles.title}>Generations</h1><p style={styles.subtitle}>Inspect and reopen exact generated scenarios. Opening a card never calls a model.</p></div>
      <button type="button" style={styles.close} onClick={onClose} aria-label="Close Generations">×</button>
    </header>
    <div style={styles.filters}>
      <label style={styles.searchLabel}>Search<input autoFocus type="search" className="studio-field" value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="Prompt, scenario, model, or map" style={styles.search} /></label>
      <label>Method<select className="studio-field" value={method} onChange={(event) => setMethod(event.currentTarget.value)}><option value="all">All methods</option>{methods.map((item) => <option key={item} value={item}>{providerName(item)}</option>)}</select></label>
      <label>Map<select className="studio-field" value={mapFilter} onChange={(event) => setMapFilter(event.currentTarget.value)}><option value="all">All maps</option>{maps.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
      <label>Status<select className="studio-field" value={status} onChange={(event) => setStatus(event.currentTarget.value)}><option value="all">All saved drafts</option><option value="verified">Simulation verified</option><option value="matches">Matches request</option><option value="needs-review">Needs semantic review</option></select></label>
      <span style={styles.count}>{visible.length} saved draft{visible.length === 1 ? '' : 's'}</span>
    </div>
    {entries === null ? <div role="status" style={styles.state}>Loading saved generations…</div> : null}
    {error ? <div role="alert" style={styles.error}><strong>Could not load generations</strong><span>{error}</span><button type="button" className="studio-btn" onClick={load}>Try again</button></div> : null}
    {entries !== null && !error && visible.length === 0 ? <div style={styles.state}><strong>No saved drafts match these filters.</strong><span>Draftless experiment rows are intentionally kept out of this authoring gallery.</span></div> : null}
    <div style={styles.grid} data-testid="generations-grid">
      {visible.map((entry) => <GenerationGalleryCard key={entry.id} entry={entry} currentMapId={currentMapId} currentMapHash={currentMapHash} onOpen={() => onOpenDraft(entry)} onSwitch={() => onSwitchMap(entry)} onDetails={() => setDetails(entry)} />)}
    </div>
    {details ? <GenerationDetails entry={details} onClose={() => setDetails(null)} /> : null}
  </section>;
}

function GenerationGalleryCard({ entry, currentMapId, currentMapHash, onOpen, onSwitch, onDetails }: { entry: CopilotGenerationHistoryEntry; currentMapId: string; currentMapHash: string | null; onOpen: () => void; onSwitch: () => void; onDetails: () => void }): JSX.Element {
  const compatibility = draftCompatibility(entry, currentMapId, currentMapHash);
  const thumbnail = [...(entry.iterationTrace ?? [])].reverse().find((step) => Boolean(step.thumbnailDataUrl))?.thumbnailDataUrl ?? null;
  const open = (): void => { if (compatibility.compatible) onOpen(); };
  const keyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if ((event.key === 'Enter' || event.key === ' ') && compatibility.compatible) { event.preventDefault(); onOpen(); }
  };
  return <article role="button" tabIndex={compatibility.compatible ? 0 : -1} aria-disabled={!compatibility.compatible} aria-label={`Open saved scenario ${entry.caseTitle}`} onClick={open} onKeyDown={keyDown} className="studio-tile-hover" style={{ ...styles.card, ...(compatibility.compatible ? styles.cardOpen : styles.cardBlocked) }} data-testid="generation-draft-card">
    <div style={styles.preview}>{thumbnail ? <img src={thumbnail} alt={`Bird's-eye preview of ${entry.caseTitle}`} style={styles.image} /> : <div style={styles.previewFallback}><span>◇</span><small>Saved native draft</small></div>}<span style={styles.mapBadge}>{entry.mapId}</span></div>
    <div style={styles.cardBody}>
      <div style={styles.cardTop}><span style={styles.method}>{providerName(entry.provider)}</span><StatusBadge entry={entry} /></div>
      <h2 style={styles.cardTitle}>{entry.caseTitle}</h2>
      <p style={styles.prompt}>{entry.prompt}</p>
      <div style={styles.meta}><span>{entry.actualModel ?? entry.requestedModel ?? 'Model not recorded'}</span><span>{entry.actorCount ?? entry.candidate!.scenarioDoc.roles.length} actors</span><span>{entry.actionCount ?? entry.candidate!.scenarioDoc.choreography.interactions.length} actions</span></div>
      {!compatibility.compatible ? <div role="note" style={styles.compatibility}>{compatibility.message}</div> : <div style={styles.openHint}>Open exact draft in Author →</div>}
      <div style={styles.actions}>
        {!compatibility.compatible && compatibility.switchable ? <button type="button" className="studio-btn" style={styles.switch} onClick={(event) => { event.stopPropagation(); onSwitch(); }}>Switch to {entry.mapId}</button> : null}
        <button type="button" className="studio-btn" style={styles.detailsButton} onClick={(event) => { event.stopPropagation(); onDetails(); }}>View details</button>
      </div>
    </div>
  </article>;
}

function StatusBadge({ entry }: { entry: CopilotGenerationHistoryEntry }): JSX.Element {
  const label = entry.semanticPass === true ? 'Matches request' : entry.simulationPass === true ? 'Simulation verified' : entry.simulationPass === false ? 'Simulation failed' : 'Draft saved';
  const tone = entry.semanticPass === true ? styles.good : entry.simulationPass === true ? styles.warn : entry.simulationPass === false ? styles.bad : styles.neutral;
  return <span style={{ ...styles.status, ...tone }}>{label}</span>;
}

function GenerationDetails({ entry, onClose }: { entry: CopilotGenerationHistoryEntry; onClose: () => void }): JSX.Element {
  return <div style={styles.backdrop} role="dialog" aria-modal="true" aria-label="Generation details" onClick={onClose}>
    <section style={styles.drawer} onClick={(event) => event.stopPropagation()}>
      <header style={styles.drawerHeader}><div><small>SAVED RESULT · NO MODEL CALLS</small><h2>{entry.caseTitle}</h2></div><button type="button" style={styles.close} onClick={onClose} aria-label="Close details">×</button></header>
      <p>{entry.prompt}</p>
      <dl style={styles.detailGrid}><Detail label="Method" value={providerName(entry.provider)} /><Detail label="Model" value={entry.actualModel ?? entry.requestedModel ?? 'Not recorded'} /><Detail label="Map" value={entry.mapId} /><Detail label="Effort" value={entry.reasoningEffort} /><Detail label="Actors" value={String(entry.actorCount ?? entry.candidate!.scenarioDoc.roles.length)} /><Detail label="Actions" value={String(entry.actionCount ?? entry.candidate!.scenarioDoc.choreography.interactions.length)} /><Detail label="Generation time" value={formatDuration(entry.latencyMs)} /><Detail label="Tokens" value={entry.totalTokens?.toLocaleString() ?? 'Not recorded'} /></dl>
      {entry.semanticAssertions?.length ? <section><h3>Semantic checks</h3>{entry.semanticAssertions.map((item) => <div key={item.id} style={item.pass ? styles.checkGood : styles.checkBad}>{item.pass ? '✓' : '✕'} {item.id} · {item.evidence}</div>)}</section> : null}
      {entry.canonicalTraceSummary ? <section><h3>Saved simulation</h3><p>{entry.canonicalTraceSummary.durationS.toFixed(1)} seconds · {entry.canonicalTraceSummary.tickCount} ticks · {entry.canonicalTraceSummary.actorIds.length} actors</p></section> : null}
      {entry.diagnostic ? <div style={styles.error}>{entry.diagnostic}</div> : null}
      <details><summary>Provenance</summary><pre style={styles.pre}>{JSON.stringify(entry.provenance, null, 2)}</pre></details>
    </section>
  </div>;
}

function Detail({ label, value }: { label: string; value: string }): JSX.Element { return <div><dt>{label}</dt><dd>{value}</dd></div>; }

export function hasExactDraft(entry: CopilotGenerationHistoryEntry): boolean {
  return entry.savedDraftStatus === 'original'
    && entry.scenarioSchemaVersion === 2
    && entry.candidate?.scenarioDoc.scenarioVersion === 2
    && entry.candidate.scenarioDoc.sourceMap?.mapId === entry.mapId;
}

export function draftCompatibility(entry: CopilotGenerationHistoryEntry, currentMapId: string, currentMapHash: string | null): { compatible: boolean; switchable: boolean; message: string } {
  if (!hasExactDraft(entry)) return { compatible: false, switchable: false, message: 'This record does not contain a supported native draft.' };
  if (entry.mapId !== currentMapId) return { compatible: false, switchable: true, message: `Created on ${entry.mapId}. Switch maps before opening it.` };
  if (entry.mapHash && currentMapHash && entry.mapHash !== currentMapHash) return { compatible: false, switchable: false, message: 'The installed map differs from the exact map used for this draft.' };
  return { compatible: true, switchable: false, message: 'Compatible with the current map.' };
}

/** Validate and clone the exact stored draft before it can replace editor state. */
export function parseSavedGenerationDraft(entry: CopilotGenerationHistoryEntry): ScenarioTemplateV2 {
  if (!hasExactDraft(entry) || !entry.candidate) throw new Error('This record does not contain a supported native draft.');
  return TemplateDocument.fromJSON(entry.candidate.scenarioDoc).data;
}

export function hasMaterialAuthoredContent(template: ScenarioTemplateV2): boolean {
  return template.roles.length > 0 || template.props.length > 0 || template.choreography.interactions.length > 0 || template.mapSignalPlans.length > 0;
}

export function providerName(id: string): string {
  const names: Record<string, string> = { 'staged-rag': 'Structured + retrieval', 'direct-llm': 'Direct LLM', 'upstream-chat2scenic': 'Upstream Chat2Scenic', 'simulation-agent': 'Simulation agent', 'simulation-agent-vision': 'Simulation agent + 2D', 'verified-template-search': 'Verified template search', 'relative-goal-optimizer': 'Relative goal optimizer' };
  return names[id] ?? id.split('-').map((word) => word ? `${word[0]!.toUpperCase()}${word.slice(1)}` : '').join(' ');
}
function formatDuration(value: number | null): string { return value === null ? 'Not recorded' : value < 1_000 ? `${Math.round(value)} ms` : `${(value / 1_000).toFixed(1)} s`; }

const GLASS_SURFACE: CSSProperties = {
  background: 'linear-gradient(180deg, var(--ueui-glass-high, rgba(19, 24, 32, 0.92)), var(--ueui-glass-low, rgba(8, 11, 16, 0.94)))',
  backdropFilter: 'blur(72px) saturate(185%)',
  WebkitBackdropFilter: 'blur(72px) saturate(185%)',
};

const styles: Record<string, CSSProperties> = {
  workspace: { position: 'fixed', inset: '42px 0 0', zIndex: 80, overflowY: 'auto', ...GLASS_SURFACE, color: 'var(--ueui-text, #f2f2f2)', padding: 'clamp(16px,3vw,34px)', font: "13px/1.45 'Inter', 'SF Pro Text', system-ui, sans-serif" },
  header: { display: 'flex', justifyContent: 'space-between', gap: 20, alignItems: 'flex-start', maxWidth: 1500, margin: '0 auto 22px' }, eyebrow: { color: 'var(--ueui-accent, #e8e044)', fontSize: 10, letterSpacing: '.13em', fontWeight: 700 }, title: { margin: '3px 0', fontSize: 30 }, subtitle: { margin: 0, color: 'var(--ueui-text-muted, #9a9a9a)' }, close: { border: 0, background: 'transparent', color: 'var(--ueui-text-muted, #9a9a9a)', fontSize: 28, cursor: 'pointer' },
  filters: { maxWidth: 1500, margin: '0 auto 18px', display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'end' }, searchLabel: { flex: '1 1 280px' }, search: { width: '100%', boxSizing: 'border-box' }, count: { marginLeft: 'auto', color: 'var(--ueui-text-muted, #9a9a9a)', paddingBottom: 7 },
  grid: { maxWidth: 1500, margin: '0 auto', display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(min(330px,100%),1fr))', gap: 14 }, card: { overflow: 'hidden', borderRadius: 'var(--ueui-radius, 10px)', background: 'linear-gradient(180deg, rgba(255,255,255,.035), rgba(255,255,255,.012))', border: '1px solid var(--ueui-line, rgba(255,255,255,.08))', minWidth: 0, outlineOffset: 3 }, cardOpen: { cursor: 'pointer' }, cardBlocked: { opacity: .72 }, preview: { height: 150, position: 'relative', background: 'rgba(8, 11, 16, 0.5)', overflow: 'hidden' }, image: { width: '100%', height: '100%', objectFit: 'cover' }, previewFallback: { height: '100%', display: 'grid', placeContent: 'center', textAlign: 'center', color: 'var(--ueui-text-muted, #9a9a9a)', fontSize: 32 }, mapBadge: { position: 'absolute', top: 9, right: 9, borderRadius: 999, padding: '4px 8px', background: 'rgba(8, 11, 16, 0.78)', border: '1px solid var(--ueui-line, rgba(255,255,255,.08))', fontSize: 10, color: 'var(--ueui-text, #f2f2f2)' }, cardBody: { padding: 13, display: 'flex', flexDirection: 'column', gap: 8 }, cardTop: { display: 'flex', gap: 8, justifyContent: 'space-between', alignItems: 'center' }, method: { color: 'var(--ueui-accent, #e8e044)', fontWeight: 650, fontSize: 11 }, status: { borderRadius: 999, padding: '3px 7px', fontSize: 9, fontWeight: 700 }, good: { background: 'rgba(87,199,133,.14)', color: 'var(--ueui-ok, #57c785)' }, warn: { background: 'rgba(240,161,60,.12)', color: 'var(--ueui-warn, #f0a13c)' }, bad: { background: 'rgba(255,107,94,.12)', color: 'var(--ueui-danger, #ff6b5e)' }, neutral: { background: 'rgba(255,255,255,.05)', color: 'var(--ueui-text-muted, #9a9a9a)' }, cardTitle: { margin: 0, fontSize: 17 }, prompt: { color: 'rgba(242,242,242,.78)', margin: 0, display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }, meta: { display: 'flex', flexWrap: 'wrap', gap: 8, color: 'var(--ueui-text-muted, #9a9a9a)', fontSize: 10 }, compatibility: { padding: 8, background: 'rgba(240,161,60,.12)', color: 'var(--ueui-warn, #f0a13c)', borderRadius: 7 }, openHint: { color: 'var(--ueui-accent, #e8e044)', fontWeight: 700 }, actions: { display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 2 }, detailsButton: { border: '1px solid var(--ueui-line-strong, rgba(255,255,255,.14))', background: 'rgba(255,255,255,.05)', color: 'var(--ueui-text, #f2f2f2)', borderRadius: 8, padding: '7px 10px', cursor: 'pointer' }, switch: { border: '1px solid var(--ueui-line-strong, rgba(255,255,255,.14))', background: 'rgba(255,255,255,.05)', color: 'var(--ueui-text, #f2f2f2)', borderRadius: 8, padding: '7px 10px', cursor: 'pointer' },
  state: { maxWidth: 1500, margin: '70px auto', display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'center', color: 'var(--ueui-text-muted, #9a9a9a)' }, error: { maxWidth: 1500, margin: '10px auto', padding: 12, background: 'rgba(255,107,94,.12)', color: 'var(--ueui-danger, #ff6b5e)', borderRadius: 'var(--ueui-radius, 10px)', display: 'flex', flexDirection: 'column', gap: 5 }, backdrop: { position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(4, 6, 10, 0.72)', display: 'flex', justifyContent: 'flex-end' }, drawer: { width: 'min(680px,94vw)', height: '100%', boxSizing: 'border-box', overflowY: 'auto', padding: 20, ...GLASS_SURFACE, borderLeft: '1px solid var(--ueui-line-strong, rgba(255,255,255,.14))' }, drawerHeader: { display: 'flex', justifyContent: 'space-between', gap: 12 }, detailGrid: { display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: 8 }, pre: { maxHeight: 300, overflow: 'auto', whiteSpace: 'pre-wrap', background: 'rgba(8, 11, 16, 0.6)', padding: 10, borderRadius: 8 }, checkGood: { color: 'var(--ueui-ok, #57c785)', margin: '4px 0' }, checkBad: { color: 'var(--ueui-danger, #ff6b5e)', margin: '4px 0' },
};
