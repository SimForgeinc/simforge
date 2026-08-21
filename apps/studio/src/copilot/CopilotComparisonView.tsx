import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { clearLiveCopilotHistory, fetchCopilotHistory } from './client';
import type { CopilotGenerationHistoryEntry, CopilotGenerationHistoryResponse } from './historyTypes';
import type { CopilotCandidate, CopilotProviderId } from './types';

interface Props {
  readonly onRerun: (entry: CopilotGenerationHistoryEntry) => void;
  readonly onApply: (candidate: CopilotCandidate) => void;
  readonly currentMapId: string;
  readonly currentMapHash: string | null;
}

const BASE_PROVIDERS: readonly CopilotProviderId[] = ['staged-rag', 'direct-llm', 'upstream-chat2scenic'];
function providerName(id: string): string {
  if (id === 'staged-rag') return 'Structured + retrieval';
  if (id === 'direct-llm') return 'Direct LLM';
  if (id === 'upstream-chat2scenic') return 'Upstream Chat2Scenic';
  return id.split('-').map((word) => word ? `${word[0]!.toUpperCase()}${word.slice(1)}` : '').join(' ');
}

export function CopilotComparisonView({ onRerun, onApply, currentMapId, currentMapHash }: Props): JSX.Element {
  const [history, setHistory] = useState<CopilotGenerationHistoryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [provider, setProvider] = useState<string>('all');
  const [model, setModel] = useState<string>('all');
  const [effort, setEffort] = useState<string>('all');
  const [status, setStatus] = useState<'all' | 'matches' | 'mismatch' | 'failed'>('all');
  const [inspecting, setInspecting] = useState<{ entry: CopilotGenerationHistoryEntry; preview: boolean } | null>(null);
  const load = (): void => { void fetchCopilotHistory().then(setHistory).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason))); };
  useEffect(load, []);

  const entries = history?.entries ?? [];
  const benchmark = entries.filter((entry) => entry.source === 'benchmark');
  const live = entries.filter((entry) => entry.source === 'live');
  const providers = [...new Set([...BASE_PROVIDERS, ...entries.map((entry) => entry.provider)])];
  const models = [...new Set(entries.map((entry) => entry.actualModel ?? entry.requestedModel).filter((value): value is string => Boolean(value)))].sort();
  const efforts = [...new Set(entries.map((entry) => entry.reasoningEffort))];
  const visible = entries.filter((entry) => (provider === 'all' || entry.provider === provider)
    && (model === 'all' || (entry.actualModel ?? entry.requestedModel) === model)
    && (effort === 'all' || entry.reasoningEffort === effort) && matchesStatus(entry, status));
  const groups = useMemo(() => groupEntries(visible), [visible]);
  const metrics = providers.map((id) => {
    const rows = benchmark.filter((entry) => entry.provider === id
      && (model === 'all' || (entry.actualModel ?? entry.requestedModel) === model)
      && (effort === 'all' || entry.reasoningEffort === effort));
    return { id, runs: rows.length, simulations: rows.filter((entry) => entry.simulationPass).length, matches: rows.filter((entry) => entry.semanticPass).length, median: median(rows.map((entry) => entry.latencyMs).filter((value): value is number => value !== null)) };
  });

  return <div style={styles.root} data-testid="copilot-comparison-view">
    <section style={styles.explainer}>
      <strong>Generation comparison</strong>
      <span>“Runs successfully” means the draft completed simulation. “Matches request” means its executable behavior passed every semantic check. These are different.</span>
    </section>
    <div style={styles.metrics} aria-label="Benchmark summary">
      {metrics.map((metric) => <article key={metric.id} style={styles.metric}>
        <strong>{providerName(metric.id)}</strong><span>{metric.matches}/{metric.runs} match request</span><span>{metric.simulations}/{metric.runs} run successfully</span><small>{formatDuration(metric.median)} median generation</small>
      </article>)}
    </div>
    {benchmark.some((entry) => entry.caseId === 'unsupported-impossible' && entry.semanticPass === false && entry.simulationPass) ? <div style={styles.danger} data-testid="impossible-case-warning">
      <strong>Known false acceptance</strong><span>All methods produced a runnable draft for the impossible flying/teleport request. Runnable does not mean faithful or physically supported.</span>
    </div> : null}
    {history?.experiments.length ? <details style={styles.registry} open><summary>Experiment registry ({history.experiments.length})</summary><div style={styles.experimentGrid}>{history.experiments.map((experiment) => <article key={experiment.id} style={styles.experiment}><header><strong>{experiment.title}</strong> · <span>{experiment.status}</span></header><span>{experiment.hypothesis}</span><small>Variable: {experiment.independentVariable}</small><small>{experiment.sampleCount} runs · {experiment.models.join(', ')} · {experiment.providers.map(providerName).join(', ')}</small></article>)}</div></details> : null}
    <div style={styles.filters}>
      <label>Method<select aria-label="Filter generation method" value={provider} onChange={(event) => setProvider(event.currentTarget.value)}><option value="all">All methods</option>{providers.map((id) => <option key={id} value={id}>{providerName(id)}</option>)}</select></label>
      <label>Model<select aria-label="Filter generation model" value={model} onChange={(event) => setModel(event.currentTarget.value)}><option value="all">All models</option>{models.map((id) => <option key={id} value={id}>{id}</option>)}</select></label>
      <label>Effort<select aria-label="Filter reasoning effort" value={effort} onChange={(event) => setEffort(event.currentTarget.value)}><option value="all">All efforts</option>{efforts.map((id) => <option key={id} value={id}>{id}</option>)}</select></label>
      <label>Status<select aria-label="Filter generation status" value={status} onChange={(event) => setStatus(event.currentTarget.value as typeof status)}><option value="all">All statuses</option><option value="matches">Matches request</option><option value="mismatch">Runs, but mismatches</option><option value="failed">Could not run</option></select></label>
      <span style={styles.count}>{visible.length} of {entries.length} generations</span>
      {live.length ? <button type="button" style={styles.clear} onClick={() => { void clearLiveCopilotHistory().then(load).catch((reason: unknown) => setError(String(reason))); }}>Clear {live.length} live runs</button> : null}
    </div>
    {error ? <div role="alert" style={styles.danger}>{error}</div> : null}
    {!history ? <div role="status" style={styles.loading}>Loading all generations…</div> : null}
    <div style={styles.groups}>
      {groups.map(([group, rows]) => <section key={group} style={styles.group} data-testid="copilot-generation-group">
        <header style={styles.groupHeader}><div><strong>{rows[0]?.caseTitle ?? 'Live generation'}</strong><p>{rows[0]?.prompt}</p></div><span>{rows[0]?.source === 'benchmark' ? 'Benchmark evidence' : 'Live session'}</span></header>
        <div style={styles.grid}>{providers.map((id) => {
          const methodRows = rows.filter((entry) => entry.provider === id);
          if (!methodRows.length) return provider === 'all' && rows[0]?.source === 'benchmark' ? <div key={id} style={styles.empty}><strong>{providerName(id)}</strong><span>Not recorded</span></div> : null;
          return methodRows.map((entry) => <GenerationCard key={entry.id} entry={entry} onRerun={onRerun} onApply={onApply} onInspect={(preview) => setInspecting({ entry, preview })} currentMapId={currentMapId} currentMapHash={currentMapHash} />);
        })}</div>
      </section>)}
    </div>
    {history ? <footer style={styles.footer}>Viewing and previewing use only the saved result and never call a model. The original 30-run benchmark did not retain native drafts; those entries still expose their saved assertions and diagnostics. “Run again” is a separate, paid, nondeterministic generation.</footer> : null}
    {inspecting ? <SavedResultDrawer entry={inspecting.entry} preview={inspecting.preview} currentMapId={currentMapId} currentMapHash={currentMapHash} onApply={onApply} onClose={() => setInspecting(null)} /> : null}
  </div>;
}

function GenerationCard({ entry, onRerun, onApply, onInspect, currentMapId, currentMapHash }: { entry: CopilotGenerationHistoryEntry; onRerun: Props['onRerun']; onApply: Props['onApply']; onInspect: (preview: boolean) => void; currentMapId: string; currentMapHash: string | null }): JSX.Element {
  const requested = entry.semanticPass === true;
  const runnable = entry.simulationPass === true;
  return <article style={{ ...styles.card, ...(requested ? styles.cardMatch : runnable ? styles.cardMismatch : styles.cardFailed) }} data-testid="copilot-generation-card">
    <header style={styles.cardHeader}><strong>{providerName(entry.provider)}</strong><span style={requested ? styles.badgeMatch : runnable ? styles.badgeMismatch : styles.badgeFailed}>{requested ? 'Matches request' : runnable ? 'Runnable · mismatch' : entry.simulationPass === false ? 'Could not run' : 'Not verified'}</span></header>
    <div style={styles.meta}>{entry.actualModel ?? 'model not recorded'} · {entry.reasoningEffort} effort · {entry.mapId} · seed {entry.seed ?? 'not recorded'}{entry.artifactId ? ` · ${entry.artifactId.includes('inspection-rerun') ? 'inspection rerun' : entry.artifactId.includes('chat2scenic-20260803') ? 'original benchmark' : 'experiment artifact'}` : ''}</div>
    <div style={styles.checks}><Result label="Materialized" value={entry.materializationPass} /><Result label="Full 20s simulation" value={entry.simulationPass && entry.simulationDurationS === 20} /><Result label="Semantic checks" value={entry.semanticPass} /></div>
    <div style={styles.summary}><span>{entry.actorCount ?? 'not recorded'} actors</span><span>{entry.actionCount ?? 'not recorded'} actions</span><span>{entry.triggerSummary?.length ? entry.triggerSummary.join(', ') : 'triggers not recorded'}</span></div>
    {entry.provider === 'upstream-chat2scenic' ? <div style={styles.scenic}><Result label="Scenic compiled" value={entry.scenicCompilePass} /><Result label="Scenic sampled" value={entry.scenicSamplePass} /></div> : null}
    {entry.semanticAssertions?.length ? <div style={styles.assertions}>{entry.semanticAssertions.map((assertion) => <span key={assertion.id} style={assertion.pass ? styles.assertPass : styles.assertFail}>{assertion.pass ? '✓' : '✕'} {assertion.id}: {assertion.evidence}</span>)}</div> : <small>Semantic assertion details not recorded.</small>}
    {entry.diagnostic ? <div style={styles.diagnostic}><strong>{entry.failureCategory ?? 'Diagnostic'}</strong><span>{entry.diagnostic}</span></div> : null}
    <div style={styles.performance}><span>{formatDuration(entry.latencyMs)}</span><span>{entry.totalTokens?.toLocaleString() ?? 'not recorded'} tokens</span><span>{entry.apiCalls ?? 'not recorded'} calls</span><span>{entry.repairCount ?? 'not recorded'} repairs</span></div>
    {entry.intent ? <IntentSummary entry={entry} /> : <div style={styles.notRecorded}>Generated intent and actor details were not stored in this historical benchmark artifact.</div>}
    {entry.iterationTrace?.length ? <details style={styles.details}><summary>Iteration trace ({entry.iterationTrace.length})</summary><div style={styles.trace}>{entry.iterationTrace.map((iteration) => <article key={iteration.iteration} style={styles.traceStep}>{iteration.thumbnailDataUrl ? <img src={iteration.thumbnailDataUrl} alt={iteration.altText ?? `Map preview after generation iteration ${iteration.iteration}`} style={styles.thumbnail} /> : null}<strong>Iteration {iteration.iteration}</strong><span>{iteration.summary}</span>{iteration.legend?.length ? <small>Legend: {iteration.legend.join(' · ')}</small> : null}{iteration.toolCalls.map((call, index) => <small key={`${call.name}-${index}`}>{call.status === 'success' ? '✓' : call.status === 'failure' ? '✕' : '—'} {call.name}: {call.summary}</small>)}</article>)}</div></details> : null}
    <details style={styles.details}><summary>Technical details & provenance</summary><dl><dt>Prompt</dt><dd>{entry.prompt}</dd><dt>Outcome</dt><dd>{entry.outcome ?? 'not recorded'}</dd><dt>Provenance</dt><dd><pre>{JSON.stringify(entry.provenance ?? 'not recorded', null, 2)}</pre></dd><dt>Generated Scenic</dt><dd><pre>{entry.generatedScenic ?? 'not recorded'}</pre></dd><dt>Direct typed draft</dt><dd><pre>{entry.directTypedDraft ? JSON.stringify(entry.directTypedDraft, null, 2) : 'not recorded'}</pre></dd></dl></details>
    <div style={styles.actions}>
      <button type="button" style={styles.inspect} onClick={() => onInspect(false)}>View saved result</button>
      <button type="button" style={styles.preview} disabled={!entry.candidate} title={entry.candidate ? 'Render the stored draft locally without model calls' : 'The original draft was not recorded'} onClick={() => onInspect(true)}>Preview saved scenario</button>
      {entry.candidate ? <button type="button" style={styles.apply} disabled={!isSavedDraftCompatible(entry, currentMapId, currentMapHash)} title={savedDraftCompatibilityMessage(entry, currentMapId, currentMapHash)} onClick={() => onApply(entry.candidate!)}>Apply saved draft</button> : null}
      <button type="button" style={styles.rerun} onClick={() => confirmRunAgain(entry, onRerun)}>Run again</button>
    </div>
    {entry.source === 'benchmark' ? <small style={styles.readOnly}>Historical evidence · read-only. {entry.savedDraftStatus === 'original' ? 'Original draft retained.' : 'Original draft not recorded.'}</small> : null}
  </article>;
}

export function confirmRunAgain(entry: CopilotGenerationHistoryEntry, onRerun: Props['onRerun'], confirm: (message: string) => boolean = window.confirm): void {
  if (confirm('Run this prompt again? This makes new model calls, can produce a different result, and consumes API tokens.')) onRerun(entry);
}

export function isSavedDraftCompatible(entry: CopilotGenerationHistoryEntry, currentMapId: string, currentMapHash: string | null): boolean {
  if (!entry.candidate || entry.scenarioSchemaVersion !== 2 || entry.mapId !== currentMapId) return false;
  return !entry.mapHash || !currentMapHash || entry.mapHash === currentMapHash;
}

function savedDraftCompatibilityMessage(entry: CopilotGenerationHistoryEntry, currentMapId: string, currentMapHash: string | null): string {
  if (!entry.candidate) return 'No original native draft was recorded.';
  if (entry.scenarioSchemaVersion !== 2) return `Saved schema ${entry.scenarioSchemaVersion ?? 'unknown'} is not supported by this editor.`;
  if (entry.mapId !== currentMapId) return `Switch to ${entry.mapId} to apply this saved draft.`;
  if (entry.mapHash && currentMapHash && entry.mapHash !== currentMapHash) return 'The current map asset differs from the exact map used by this result.';
  return 'Apply the exact saved native draft without calling a model.';
}

function SavedResultDrawer({ entry, preview, currentMapId, currentMapHash, onApply, onClose }: { entry: CopilotGenerationHistoryEntry; preview: boolean; currentMapId: string; currentMapHash: string | null; onApply: Props['onApply']; onClose: () => void }): JSX.Element {
  const compatible = isSavedDraftCompatible(entry, currentMapId, currentMapHash);
  return <div role="dialog" aria-modal="true" aria-label="Saved generation result" style={styles.modalBackdrop}>
    <section style={styles.drawer} data-testid="saved-result-drawer">
      <header style={styles.drawerHeader}><div><small>SAVED RESULT · ZERO MODEL CALLS</small><h3>{entry.caseTitle}</h3></div><button type="button" style={styles.close} aria-label="Close saved result" onClick={onClose}>×</button></header>
      {preview ? entry.candidate ? <SavedBirdsEye candidate={entry.candidate} /> : <div style={styles.notRecorded}><strong>Map preview unavailable</strong><span>The original native draft was not recorded for this run. No reconstruction or model rerun was performed.</span></div> : null}
      <div style={styles.savedGrid}>
        <Key label="Method" value={providerName(entry.provider)} /><Key label="Map" value={entry.mapId} /><Key label="Map hash" value={entry.mapHash ?? 'not recorded'} /><Key label="Saved result hash" value={entry.savedResultHash ?? 'not recorded'} />
      </div>
      {entry.intent ? <IntentSummary entry={entry} /> : <div style={styles.notRecorded}>Generated intent was not retained. The original saved benchmark still records the prompt, counts, assertions, outcome, and diagnostics below.</div>}
      {entry.candidate ? <details style={styles.details} open><summary>Original native draft</summary><pre style={styles.savedJson}>{JSON.stringify(entry.candidate.scenarioDoc, null, 2)}</pre></details> : null}
      {entry.canonicalTraceSummary ? <details style={styles.details}><summary>Canonical simulation trace summary</summary><pre style={styles.savedJson}>{JSON.stringify(entry.canonicalTraceSummary, null, 2)}</pre></details> : <div style={styles.notRecorded}>Full canonical trace details were not recorded. Saved aggregate: {entry.simulationDurationS ?? 'unknown'} seconds · {entry.simulationPass === true ? 'simulation passed' : entry.simulationPass === false ? 'simulation failed' : 'not verified'}.</div>}
      {entry.semanticAssertions?.length ? <div style={styles.assertions}>{entry.semanticAssertions.map((assertion) => <span key={assertion.id} style={assertion.pass ? styles.assertPass : styles.assertFail}>{assertion.pass ? '✓' : '✕'} {assertion.id}: {assertion.evidence}</span>)}</div> : null}
      {entry.diagnostic ? <div style={styles.diagnostic}><strong>{entry.failureCategory ?? 'Diagnostic'}</strong><span>{entry.diagnostic}</span></div> : null}
      <div style={styles.actions}>{entry.candidate ? <button type="button" style={styles.apply} disabled={!compatible} title={savedDraftCompatibilityMessage(entry, currentMapId, currentMapHash)} onClick={() => onApply(entry.candidate!)}>Apply saved draft</button> : null}<button type="button" style={styles.inspect} onClick={onClose}>Close</button></div>
      {entry.candidate && !compatible ? <small style={styles.readOnly}>{savedDraftCompatibilityMessage(entry, currentMapId, currentMapHash)}</small> : null}
    </section>
  </div>;
}

function SavedBirdsEye({ candidate }: { candidate: CopilotCandidate }): JSX.Element {
  const points = candidate.scenarioDoc.roles.flatMap((role) => {
    if (!('pose' in role)) return [];
    const pose = role.pose as unknown as { x?: number; z?: number; position?: { x?: number; z?: number } };
    const x = pose.x ?? pose.position?.x; const z = pose.z ?? pose.position?.z;
    return typeof x === 'number' && typeof z === 'number' ? [{ id: role.id, x, z }] : [];
  });
  if (!points.length) return <div style={styles.notRecorded}>The stored draft has map-relative bindings but no scene coordinates suitable for an offline bird’s-eye preview. The exact draft remains inspectable below.</div>;
  const minX = Math.min(...points.map((point) => point.x)); const maxX = Math.max(...points.map((point) => point.x));
  const minZ = Math.min(...points.map((point) => point.z)); const maxZ = Math.max(...points.map((point) => point.z));
  const sx = (x: number): number => 30 + ((x - minX) / Math.max(1, maxX - minX)) * 440;
  const sy = (z: number): number => 270 - ((z - minZ) / Math.max(1, maxZ - minZ)) * 240;
  return <figure style={styles.savedFigure}><svg role="img" aria-label={`Offline bird's-eye preview of ${points.length} saved actors`} viewBox="0 0 500 300" style={styles.savedSvg}><rect width="500" height="300" fill="#14191f" />{points.map((point) => <g key={point.id}><circle cx={sx(point.x)} cy={sy(point.z)} r="8" fill="#f2b84b" stroke="#fff1b9" strokeWidth="2" /><text x={sx(point.x) + 12} y={sy(point.z) + 4} fill="#fff1b9" fontSize="12">{point.id}</text></g>)}</svg><figcaption>Deterministic offline preview from stored actor coordinates. It does not call the API or regenerate the scenario.</figcaption></figure>;
}

function Key({ label, value }: { label: string; value: string }): JSX.Element { return <div style={styles.savedKey}><small>{label}</small><span>{value}</span></div>; }

function IntentSummary({ entry }: { entry: CopilotGenerationHistoryEntry }): JSX.Element {
  const intent = entry.intent!;
  return <details style={styles.details}><summary>Generated content</summary><div style={styles.intent}><strong>{intent.scenario}</strong><span>Outcome: {intent.desiredOutcome}</span><span>Actors: {[intent.ego, ...intent.adversaries, ...intent.contextActors].map((actor) => `${actor.catalogId} (${actor.role}: ${actor.behavior})`).join(' · ')}</span><span>Relations: {intent.spatialRelations.join(', ') || 'none recorded'}</span><span>Restrictions: {intent.restrictions.join(', ') || 'none recorded'}</span></div></details>;
}

function Result({ label, value }: { label: string; value: boolean | null }): JSX.Element { return <span style={value === true ? styles.pass : value === false ? styles.fail : styles.unknown}>{value === true ? '✓' : value === false ? '✕' : '—'} {label}</span>; }
function matchesStatus(entry: CopilotGenerationHistoryEntry, status: 'all' | 'matches' | 'mismatch' | 'failed'): boolean { return status === 'all' || (status === 'matches' ? entry.semanticPass === true : status === 'mismatch' ? entry.simulationPass === true && entry.semanticPass !== true : entry.simulationPass === false); }
function groupEntries(entries: readonly CopilotGenerationHistoryEntry[]): Array<[string, CopilotGenerationHistoryEntry[]]> { const map = new Map<string, CopilotGenerationHistoryEntry[]>(); for (const entry of entries) { const key = entry.caseId ? `benchmark:${entry.caseId}` : `live:${entry.id}`; map.set(key, [...(map.get(key) ?? []), entry]); } return [...map.entries()]; }
function median(values: readonly number[]): number | null { if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)] ?? null; }
function formatDuration(ms: number | null): string { return ms === null ? 'not recorded' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`; }

const styles: Record<string, CSSProperties> = {
  registry: { padding: 10, border: '1px solid var(--ueui-line, rgba(255,255,255,.08))', borderRadius: 'var(--ueui-radius, 10px)', background: 'rgba(255,255,255,.03)', color: 'rgba(242,242,242,.82)' }, experimentGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 7, paddingTop: 8 }, experiment: { display: 'flex', flexDirection: 'column', gap: 4, padding: 8, background: 'rgba(255,255,255,.04)', borderRadius: 7, fontSize: 10 },
  root: { display: 'flex', flexDirection: 'column', gap: 12 }, explainer: { display: 'flex', flexDirection: 'column', gap: 4, padding: 12, borderRadius: 'var(--ueui-radius, 10px)', background: 'var(--ueui-accent-soft, rgba(232,224,68,.16))', color: 'var(--ueui-text, #f2f2f2)', fontSize: 12 }, metrics: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(155px,1fr))', gap: 8 }, metric: { display: 'flex', flexDirection: 'column', gap: 3, padding: 10, borderRadius: 'var(--ueui-radius, 10px)', background: 'linear-gradient(180deg, rgba(255,255,255,.035), rgba(255,255,255,.012))', border: '1px solid var(--ueui-line, rgba(255,255,255,.08))', fontSize: 11 }, danger: { display: 'flex', flexDirection: 'column', gap: 3, padding: 11, border: '1px solid rgba(255,107,94,.35)', borderRadius: 'var(--ueui-radius, 10px)', background: 'rgba(255,107,94,.1)', color: 'var(--ueui-danger, #ff6b5e)', fontSize: 12 }, filters: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }, count: { marginLeft: 'auto', color: 'var(--ueui-text-muted, #9a9a9a)', fontSize: 11 }, clear: { border: '1px solid rgba(255,107,94,.4)', borderRadius: 8, background: 'rgba(255,107,94,.1)', color: 'var(--ueui-danger, #ff6b5e)', padding: '7px 9px', cursor: 'pointer' }, loading: { padding: 20, textAlign: 'center', color: 'var(--ueui-text-muted, #9a9a9a)' }, groups: { display: 'grid', gap: 12 }, group: { border: '1px solid var(--ueui-line, rgba(255,255,255,.08))', borderRadius: 'var(--ueui-radius, 10px)', overflow: 'hidden', background: 'rgba(255,255,255,.02)' }, groupHeader: { display: 'flex', justifyContent: 'space-between', gap: 10, padding: 12, background: 'rgba(255,255,255,.04)' }, grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(250px,1fr))', gap: 1, overflowX: 'auto', background: 'var(--ueui-line, rgba(255,255,255,.08))' }, card: { padding: 11, background: 'var(--ueui-glass-high, rgba(19, 24, 32, 0.92))', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }, cardMatch: { borderTop: '3px solid var(--ueui-ok, #57c785)' }, cardMismatch: { borderTop: '3px solid var(--ueui-warn, #f0a13c)' }, cardFailed: { borderTop: '3px solid var(--ueui-danger, #ff6b5e)' }, cardHeader: { display: 'flex', justifyContent: 'space-between', gap: 6, alignItems: 'flex-start' }, badgeMatch: { color: 'var(--ueui-ok, #57c785)', fontSize: 9 }, badgeMismatch: { color: 'var(--ueui-warn, #f0a13c)', fontSize: 9 }, badgeFailed: { color: 'var(--ueui-danger, #ff6b5e)', fontSize: 9 }, meta: { fontSize: 9, color: 'var(--ueui-text-muted, #9a9a9a)' }, checks: { display: 'flex', flexWrap: 'wrap', gap: 5 }, scenic: { display: 'flex', gap: 6, padding: 6, background: 'rgba(240,161,60,.1)', borderRadius: 6 }, pass: { color: 'var(--ueui-ok, #57c785)', fontSize: 10 }, fail: { color: 'var(--ueui-danger, #ff6b5e)', fontSize: 10 }, unknown: { color: 'var(--ueui-text-muted, #9a9a9a)', fontSize: 10 }, summary: { display: 'flex', flexDirection: 'column', gap: 2, fontSize: 10, color: 'rgba(242,242,242,.82)' }, assertions: { display: 'flex', flexDirection: 'column', gap: 3 }, assertPass: { color: 'var(--ueui-ok, #57c785)', fontSize: 10 }, assertFail: { color: 'var(--ueui-warn, #f0a13c)', fontSize: 10 }, diagnostic: { display: 'flex', flexDirection: 'column', gap: 2, padding: 7, borderRadius: 6, background: 'rgba(240,161,60,.1)', color: 'var(--ueui-warn, #f0a13c)', fontSize: 10 }, performance: { display: 'flex', gap: 8, flexWrap: 'wrap', color: 'var(--ueui-text-muted, #9a9a9a)', fontSize: 9 }, notRecorded: { padding: 7, borderRadius: 6, background: 'rgba(255,255,255,.04)', color: 'var(--ueui-text-muted, #9a9a9a)', fontSize: 10, display: 'flex', flexDirection: 'column', gap: 4 }, details: { fontSize: 10, color: 'rgba(242,242,242,.78)' }, intent: { display: 'flex', flexDirection: 'column', gap: 4, paddingTop: 6 }, trace: { display: 'grid', gap: 6, paddingTop: 6 }, traceStep: { display: 'flex', flexDirection: 'column', gap: 3, padding: 7, background: 'rgba(255,255,255,.04)', borderRadius: 7 }, thumbnail: { width: '100%', maxHeight: 150, objectFit: 'cover', borderRadius: 6 }, actions: { display: 'flex', gap: 6, flexWrap: 'wrap' }, inspect: { padding: 8, border: '1px solid var(--ueui-line-strong, rgba(255,255,255,.14))', borderRadius: 8, background: 'rgba(255,255,255,.05)', color: 'var(--ueui-text, #f2f2f2)', fontWeight: 650, cursor: 'pointer' }, preview: { padding: 8, border: '1px solid var(--ueui-line-strong, rgba(255,255,255,.14))', borderRadius: 8, background: 'rgba(255,255,255,.05)', color: 'var(--ueui-text, #f2f2f2)', fontWeight: 650, cursor: 'pointer' }, apply: { padding: 8, border: '1px solid transparent', borderRadius: 8, background: 'var(--ueui-accent, #e8e044)', color: '#10120a', fontWeight: 700, cursor: 'pointer' }, rerun: { padding: 8, border: '1px solid var(--ueui-line-strong, rgba(255,255,255,.14))', borderRadius: 8, background: 'rgba(255,255,255,.05)', color: 'var(--ueui-text, #f2f2f2)', fontWeight: 650, cursor: 'pointer' }, readOnly: { color: 'var(--ueui-text-muted, #9a9a9a)' }, empty: { padding: 12, background: 'rgba(255,255,255,.03)', color: 'var(--ueui-text-muted, #9a9a9a)', display: 'flex', flexDirection: 'column', gap: 5 }, footer: { padding: 10, borderTop: '1px solid var(--ueui-line, rgba(255,255,255,.08))', color: 'var(--ueui-text-muted, #9a9a9a)', fontSize: 10, lineHeight: 1.4 }, modalBackdrop: { position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(4, 6, 10, 0.72)', display: 'flex', justifyContent: 'flex-end' }, drawer: { width: 'min(680px,94vw)', height: '100%', overflowY: 'auto', background: 'linear-gradient(180deg, var(--ueui-glass-high, rgba(19, 24, 32, 0.92)), var(--ueui-glass-low, rgba(8, 11, 16, 0.94)))', backdropFilter: 'blur(72px) saturate(185%)', WebkitBackdropFilter: 'blur(72px) saturate(185%)', borderLeft: '1px solid var(--ueui-line-strong, rgba(255,255,255,.14))', padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }, drawerHeader: { display: 'flex', justifyContent: 'space-between', gap: 12 }, close: { border: 0, background: 'transparent', color: 'var(--ueui-text-muted, #9a9a9a)', fontSize: 24 }, savedGrid: { display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: 8 }, savedKey: { display: 'flex', flexDirection: 'column', gap: 2, padding: 8, background: 'rgba(255,255,255,.04)', borderRadius: 7, overflowWrap: 'anywhere' }, savedJson: { maxHeight: 360, overflow: 'auto', whiteSpace: 'pre-wrap', background: 'rgba(8, 11, 16, 0.6)', padding: 10, borderRadius: 8 }, savedFigure: { margin: 0, display: 'flex', flexDirection: 'column', gap: 5, color: 'var(--ueui-text-muted, #9a9a9a)', fontSize: 10 }, savedSvg: { width: '100%', maxHeight: 340, border: '1px solid var(--ueui-line, rgba(255,255,255,.08))', borderRadius: 'var(--ueui-radius, 10px)' },
};
