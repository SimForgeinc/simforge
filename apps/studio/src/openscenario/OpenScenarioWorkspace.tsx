import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { AsamCapabilityEntry } from '@uniscenarios/openscenario/types';
import {
  downloadSnapshotFile,
  type OpenScenarioExportProfile,
  type OpenScenarioLocalBundle,
  type OpenScenarioLocalRunEvidence,
  type OpenScenarioSnapshot,
  type OpenScenarioWorkspaceState,
} from './model';
import { buildLocalEsminiBundle, cancelLocalEsminiRun, submitLocalEsminiRun, waitForLocalEsminiRun } from './localClient';
import { physicsReasonLabel, physicsSummaryForTrace, type PhysicsDisplaySummary } from '@uniscenarios/playback';
import type { ValidationReport } from '@uniscenarios/scenario-model';
import { PlannedAuthoringFormats, ScenarioReadinessSummary } from '../editor/ScenarioActionsPanel';

type Section = 'overview' | 'schema' | 'compatibility' | 'issues' | 'mapping' | 'validation' | 'external' | 'files';

export function OpenScenarioWorkspace({
  state,
  onRetry,
  onClose,
  onLocateSource,
  templateValidation,
  physicsSummary,
  initialSection = 'overview',
}: {
  state: OpenScenarioWorkspaceState;
  onRetry(): void;
  onClose(): void;
  onLocateSource?(sourceId: string): void;
  templateValidation?: ValidationReport | null;
  physicsSummary?: PhysicsDisplaySummary | null;
  initialSection?: Section;
}): JSX.Element {
  const [section, setSection] = useState<Section>(initialSection);
  const [profile, setProfile] = useState<OpenScenarioExportProfile>('native-1.4');
  const [localBundle, setLocalBundle] = useState<OpenScenarioLocalBundle | null>(null);
  const [bundleBusy, setBundleBusy] = useState(false);
  const [runEvidence, setRunEvidence] = useState<OpenScenarioLocalRunEvidence | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const pollAbort = useRef<AbortController | null>(null);
  useEffect(() => () => pollAbort.current?.abort(), []);
  useEffect(() => {
    setLocalBundle(null); setRunEvidence(null); setLocalError(null); pollAbort.current?.abort();
  }, [state.status === 'ready' ? state.snapshot.concrete.inputHash : state.status]);
  const buildProfile = async (): Promise<void> => {
    if (state.status !== 'ready' || profile === 'native-1.4') return;
    setBundleBusy(true); setLocalError(null); setRunEvidence(null);
    try {
      const mode = profile === 'esmini-1.3-trajectory' ? 'deterministic-trajectory' : 'supported-actions';
      setLocalBundle(await buildLocalEsminiBundle(state.snapshot, mode));
    } catch (error) { setLocalBundle(null); setLocalError(error instanceof Error ? error.message : String(error)); }
    finally { setBundleBusy(false); }
  };
  const runExternal = async (): Promise<void> => {
    if (!localBundle) return;
    setLocalError(null); setRunEvidence(null); pollAbort.current?.abort();
    try {
      const initial = await submitLocalEsminiRun(localBundle.bundleId);
      setRunEvidence({ snapshot: initial, artifacts: [], unsupportedSemantics: [] });
      const controller = new AbortController(); pollAbort.current = controller;
      await waitForLocalEsminiRun(initial.jobId, setRunEvidence, controller.signal);
    } catch (error) { setLocalError(error instanceof Error ? error.message : String(error)); }
  };
  const cancelExternal = async (): Promise<void> => {
    const jobId = runEvidence?.snapshot.jobId; if (!jobId) return;
    await cancelLocalEsminiRun(jobId).catch((error) => setLocalError(error instanceof Error ? error.message : String(error)));
  };
  return <section style={styles.root} data-testid="openscenario-workspace" aria-label="OpenSCENARIO workspace">
    <aside style={styles.sidebar}>
      <div style={styles.title}>OpenSCENARIO</div>
      <div style={styles.subtitle}>Interoperability workspace</div>
      <nav style={styles.nav} aria-label="OpenSCENARIO sections">
        {(['overview', 'schema', 'compatibility', 'issues', 'mapping', 'validation', 'external', 'files'] as const).map((id) => (
          <button key={id} type="button" onClick={() => setSection(id)} aria-current={section === id ? 'page' : undefined} style={{ ...styles.navButton, ...(section === id ? styles.navActive : null) }}>
            {label(id)}
            {id === 'issues' && state.status === 'ready' ? <span style={styles.count}>{state.snapshot.artifact.issues.length + state.snapshot.artifact.warnings.length}</span> : null}
          </button>
        ))}
      </nav>
      <div style={styles.sidebarFoot}>Generated source is read-only. Make changes in Author, then regenerate this immutable snapshot.</div>
    </aside>
    <main style={styles.main}>
      <header style={styles.mainHeader}>
        <div>
          <div style={styles.eyebrow}>{profile === 'native-1.4' ? 'ASAM OpenSCENARIO XML 1.4' : 'ASAM OpenSCENARIO XML 1.3 · local esmini'}</div>
          <h1 style={styles.heading}>{label(section)}</h1>
        </div>
        <div style={styles.headerActions}>
          <button type="button" style={styles.secondaryButton} onClick={onRetry} disabled={state.status === 'loading'}>Regenerate</button>
          <button type="button" style={styles.closeButton} onClick={onClose} aria-label="Close OpenSCENARIO workspace">×</button>
        </div>
      </header>
      <div style={styles.body}>
        {state.status === 'ready' ? <ProfileBar profile={profile} onProfile={(next) => { setProfile(next); setLocalBundle(null); setRunEvidence(null); setLocalError(null); }} localBundle={localBundle} busy={bundleBusy} onBuild={() => void buildProfile()} /> : null}
        {localError ? <div style={styles.errorBanner} role="alert">{localError}</div> : null}
        <WorkspaceBody state={state} section={section} onRetry={onRetry} onLocateSource={onLocateSource} profile={profile} localBundle={localBundle} runEvidence={runEvidence} onRun={() => void runExternal()} onCancel={() => void cancelExternal()} templateValidation={templateValidation} physicsSummary={physicsSummary} />
      </div>
    </main>
  </section>;
}

function WorkspaceBody({ state, section, onRetry, onLocateSource, profile, localBundle, runEvidence, onRun, onCancel, templateValidation, physicsSummary }: { state: OpenScenarioWorkspaceState; section: Section; onRetry(): void; onLocateSource?: (id: string) => void; profile: OpenScenarioExportProfile; localBundle: OpenScenarioLocalBundle | null; runEvidence: OpenScenarioLocalRunEvidence | null; onRun(): void; onCancel(): void; templateValidation?: ValidationReport | null; physicsSummary?: PhysicsDisplaySummary | null }): JSX.Element {
  if (state.status === 'empty') return <Empty title="Nothing to export yet" detail={state.reason} action="Return to Author and place an actor" />;
  if (state.status === 'loading') return <Empty title="Building exact export snapshot…" detail="Materializing this revision, simulating its canonical trace, and generating the fail-closed XML 1.4 artifact." busy />;
  if (state.status === 'error') return <Empty title="Could not prepare this revision" detail={state.message} action="Retry" onAction={onRetry} />;
  const snapshot = state.snapshot;
  if (section === 'overview') return <Overview snapshot={snapshot} profile={profile} localBundle={localBundle} />;
  if (section === 'schema') return <Schema snapshot={snapshot} profile={profile} localBundle={localBundle} />;
  if (section === 'compatibility') return profile === 'native-1.4' ? <Compatibility snapshot={snapshot} /> : <EsminiCompatibility bundle={localBundle} />;
  if (section === 'issues') return <Issues snapshot={snapshot} onLocateSource={onLocateSource} />;
  if (section === 'mapping') return <Mapping snapshot={snapshot} onLocateSource={onLocateSource} />;
  if (section === 'validation') return <><ScenarioReadiness templateValidation={templateValidation} physicsSummary={physicsSummary ?? physicsSummaryForTrace(snapshot.concrete.trace)} /><Validation snapshot={snapshot} bundle={localBundle} evidence={runEvidence} /></>;
  if (section === 'external') return <ExternalValidation bundle={localBundle} evidence={runEvidence} onRun={onRun} onCancel={onCancel} />;
  return <Files snapshot={snapshot} bundle={localBundle} evidence={runEvidence} />;
}

function ScenarioReadiness({ templateValidation, physicsSummary }: { templateValidation?: ValidationReport | null; physicsSummary: PhysicsDisplaySummary }): JSX.Element | null {
  if (!templateValidation) return null;
  return <ScenarioReadinessSummary validation={templateValidation} physicsSummary={physicsSummary} />;
}

function ProfileBar({ profile, onProfile, localBundle, busy, onBuild }: { profile: OpenScenarioExportProfile; onProfile(profile: OpenScenarioExportProfile): void; localBundle: OpenScenarioLocalBundle | null; busy: boolean; onBuild(): void }): JSX.Element {
  return <div style={styles.profileBar} data-testid="openscenario-profile-bar"><label style={styles.profileLabel}>Export profile<select aria-label="OpenSCENARIO export profile" value={profile} onChange={(event) => onProfile(event.target.value as OpenScenarioExportProfile)} className="studio-field" style={styles.select}><option value="native-1.4">Native XML 1.4 · interchange</option><option value="esmini-1.3-trajectory">esmini XML 1.3 · exact trajectory</option><option value="esmini-1.3-actions">esmini XML 1.3 · supported actions</option></select></label>{profile !== 'native-1.4' ? <button type="button" className="studio-btn" style={styles.primaryButton} onClick={onBuild} disabled={busy}>{busy ? 'Building and validating…' : localBundle ? 'Rebuild local bundle' : 'Build local bundle'}</button> : <span style={styles.profileHint}>Native artifact is generated from the exact playback snapshot.</span>}{localBundle ? <Badge text="XSD valid" tone="good" /> : null}</div>;
}

function Overview({ snapshot, profile, localBundle }: { snapshot: OpenScenarioSnapshot; profile: OpenScenarioExportProfile; localBundle: OpenScenarioLocalBundle | null }): JSX.Element {
  const ready = snapshot.artifact.state === 'ready';
  const physics = physicsSummaryForTrace(snapshot.concrete.trace);
  return <div style={styles.grid}>
    <Card title="Export readiness"><Status status={profile === 'native-1.4' ? (ready ? 'passed' : 'failed') : localBundle ? 'passed' : 'not-run'} text={profile === 'native-1.4' ? (ready ? 'XML 1.4 artifact ready' : 'Export rejected') : localBundle ? 'Runnable XML 1.3 bundle ready' : 'Build not run'} /><p style={styles.copy}>{profile === 'native-1.4' ? (ready ? 'This exact materialized input has a generated trajectory-replay artifact.' : `${snapshot.artifact.issues.length} unsupported or invalid feature(s) must be resolved.`) : localBundle ? 'Complete, hash-verified OpenDRIVE and canonical trace are attached.' : 'Choose Build local bundle to resolve dependencies and run the official XSD.'}</p></Card>
    <Card title="Intent"><Key label="Profile" value={localBundle?.profile ?? snapshot.artifact.profile} /><Key label="Intent" value={localBundle?.behaviorParityScope ?? snapshot.artifact.intent} /><Key label="Duration" value={`${snapshot.concrete.input.clipSeconds.toFixed(2)} s`} /><Key label="Timestep" value={`${snapshot.concrete.input.dt} s`} /></Card>
    <Card title="Immutable identity"><Hash label="Template" value={snapshot.source.templateHash} /><Hash label="Concrete input" value={snapshot.concrete.inputHash} /><Hash label="Canonical trace" value={snapshot.concrete.traceHash} /></Card>
    <Card title="Road dependency"><Key label="Map" value={snapshot.map.id} /><Key label="Logic file" value={snapshot.map.roadFile} /><Hash label="OpenDRIVE" value={snapshot.map.xodrDigest} /><Hash label="Lane graph" value={snapshot.map.laneGraphDigest} /></Card>
    <Card title="Contents"><Key label="Actors" value={String(snapshot.concrete.input.actors.length)} /><Key label="Interactions" value={String(snapshot.concrete.input.interactions.length)} /><Key label="Signals" value={String(snapshot.concrete.input.signalPrograms.length)} /><Key label="Mappings" value={String(snapshot.source.mapping.length)} /></Card>
    <Card title="Physics provenance"><div data-testid="openscenario-physics-provenance"><Key label="Scenario mode" value={physics.legacyReplay ? 'kinematic-v1 · immutable legacy' : physics.mode} /><Key label="Dynamic actors" value={String(physics.dynamicCount)} /><Key label="Fixed actors" value={String(physics.staticCount)} />{physics.actors.map((actor) => <p style={styles.copy} key={actor.id}><code>{actor.label}</code> · {actor.mode ?? 'unknown'}{actor.profile ? ` · ${actor.profile}` : ''} · {physicsReasonLabel(actor.reason)}</p>)}</div></Card>
    <Card title="Important limitation"><p style={styles.copy}>Trajectory replay verifies portable motion. It does not claim editable controller-logic equivalence or round-trip XML import. External execution remains a separate validation stage.</p></Card>
  </div>;
}

function Schema({ snapshot, profile, localBundle }: { snapshot: OpenScenarioSnapshot; profile: OpenScenarioExportProfile; localBundle: OpenScenarioLocalBundle | null }): JSX.Element {
  const [mode, setMode] = useState<'tree' | 'raw'>('tree');
  const content = profile === 'native-1.4' ? snapshot.artifact.content : localBundle?.xml;
  if (!content) return <Empty title="No XML was generated" detail={profile === 'native-1.4' ? 'Review Issues for fail-closed export findings.' : 'Build the selected local profile first.'} />;
  return <div style={styles.fullCard}>
    <div style={styles.toolbar}><Segment active={mode === 'tree'} onClick={() => setMode('tree')}>Semantic tree</Segment><Segment active={mode === 'raw'} onClick={() => setMode('raw')}>Raw XML</Segment><span style={styles.readOnly}>Read-only</span></div>
    {mode === 'tree' ? <XmlTree content={content} /> : <pre style={styles.code} data-testid="openscenario-raw-xml">{content}</pre>}
  </div>;
}

function XmlTree({ content }: { content: string }): JSX.Element {
  const tree = useMemo(() => {
    const doc = new DOMParser().parseFromString(content, 'application/xml');
    if (doc.querySelector('parsererror')) return null;
    return doc.documentElement;
  }, [content]);
  return <div style={styles.tree}>{tree ? <XmlNode node={tree} depth={0} /> : <div>Generated XML could not be parsed for tree display.</div>}</div>;
}

function XmlNode({ node, depth }: { node: Element; depth: number }): JSX.Element {
  const [open, setOpen] = useState(depth < 2);
  const children = [...node.children];
  const attrs = [...node.attributes].slice(0, 3).map((a) => `${a.name}="${a.value}"`).join(' ');
  return <div>
    <button type="button" style={{ ...styles.treeRow, paddingLeft: depth * 16 }} onClick={() => setOpen((v) => !v)}>
      <span style={styles.disclosure}>{children.length ? (open ? '▾' : '▸') : '·'}</span><span style={styles.tag}>{node.tagName}</span>{attrs ? <span style={styles.attrs}>{attrs}</span> : null}<span style={styles.childCount}>{children.length || ''}</span>
    </button>
    {open ? children.map((child, index) => <XmlNode key={`${child.tagName}:${index}`} node={child} depth={depth + 1} />) : null}
  </div>;
}

function Compatibility({ snapshot }: { snapshot: OpenScenarioSnapshot }): JSX.Element {
  const report = snapshot.artifact.capabilityReport;
  if (!report) return <Empty title="Capability report unavailable" detail="The fail-closed export was rejected before a complete artifact could be generated. Review Issues." />;
  return <div style={styles.fullCard}><div style={styles.summaryRow}>{(['preserved', 'derived', 'extension', 'omitted'] as const).map((key) => <div style={styles.summary} key={key}><strong>{report.summary[key]}</strong><span>{key}</span></div>)}</div><div style={styles.table}>{report.fields.map((entry) => <CapabilityRow key={entry.path} entry={entry} />)}</div></div>;
}

function EsminiCompatibility({ bundle }: { bundle: OpenScenarioLocalBundle | null }): JSX.Element {
  if (!bundle) return <Empty title="Compatibility not evaluated" detail="Build the selected XML 1.3 profile to run the explicit esmini capability analysis." />;
  const counts = Object.fromEntries(['semantic-portable', 'lowered', 'trajectory-baked', 'unsupported-blocking'].map((key) => [key, bundle.capability.entries.filter((entry) => entry.disposition === key).length]));
  return <div style={styles.fullCard}><div style={styles.summaryRow}>{Object.entries(counts).map(([key, count]) => <div style={styles.summary} key={key}><strong>{count}</strong><span>{key.replace('-', ' ')}</span></div>)}</div><div style={styles.table}>{bundle.capability.entries.map((entry) => <div style={styles.esminiRow} key={entry.path}><code>{entry.path}</code><Badge text={entry.disposition} tone={entry.disposition === 'semantic-portable' ? 'good' : entry.blocking ? 'bad' : 'warn'} /><span style={styles.reason}>{entry.reason}</span></div>)}</div></div>;
}

function CapabilityRow({ entry }: { entry: AsamCapabilityEntry }): JSX.Element {
  return <div style={styles.tableRow}><code>{entry.path}</code><Badge text={entry.disposition} tone={entry.disposition === 'preserved' ? 'good' : entry.disposition === 'omitted' ? 'bad' : 'warn'} /><span>{entry.fidelity}</span><span style={styles.reason}>{entry.reason}</span></div>;
}

function Issues({ snapshot, onLocateSource }: { snapshot: OpenScenarioSnapshot; onLocateSource?: (id: string) => void }): JSX.Element {
  const rows = [...snapshot.artifact.issues.map((v) => ({ ...v, severity: 'Blocking' })), ...snapshot.artifact.warnings.map((v) => ({ ...v, severity: 'Warning' }))];
  if (!rows.length) return <Empty title="No export findings" detail="The fail-closed XML 1.4 trajectory profile generated without warnings." />;
  return <div style={styles.list}>{rows.map((issue, index) => {
    const mapping = snapshot.source.mapping.find((item) => issue.path.includes(item.sourceId));
    return <article style={styles.issue} key={`${issue.code}:${index}`}><div><Badge text={issue.severity} tone={issue.severity === 'Blocking' ? 'bad' : 'warn'} /> <code>{issue.code}</code></div><button type="button" style={styles.pathButton} disabled={!mapping || !onLocateSource} onClick={() => mapping && onLocateSource?.(mapping.sourceId)}>{issue.path}</button><p style={styles.copy}>{issue.reason}</p></article>;
  })}</div>;
}

function Mapping({ snapshot, onLocateSource }: { snapshot: OpenScenarioSnapshot; onLocateSource?: (id: string) => void }): JSX.Element {
  return <div style={styles.fullCard}><div style={styles.table}>{snapshot.source.mapping.map((item) => <div style={styles.mappingRow} key={`${item.sourcePath}:${item.exportKind}`}><button type="button" className="studio-btn" style={styles.pathButton} onClick={() => onLocateSource?.(item.sourceId)}>{item.sourcePath}</button><span>→</span><Badge text={item.exportKind} tone="neutral" /><code>{item.exportName}</code><span style={styles.selector}>{item.selector}</span></div>)}</div></div>;
}

function Validation({ snapshot, bundle, evidence }: { snapshot: OpenScenarioSnapshot; bundle: OpenScenarioLocalBundle | null; evidence: OpenScenarioLocalRunEvidence | null }): JSX.Element {
  const run = evidence?.snapshot.result;
  const stages = bundle ? [
    { label: 'Concrete model', status: 'passed', detail: 'Exact materialized input and canonical browser trace are retained.' },
    { label: 'XML 1.3 esmini profile', status: 'passed', detail: `${bundle.behaviorParityScope} export built without a blocking compatibility finding.` },
    { label: 'Official ASAM XSD', status: 'passed', detail: 'Validated locally against the digest-pinned official OpenSCENARIO 1.3.1 XSD.' },
    { label: 'Dependencies', status: 'passed', detail: 'Complete OpenDRIVE, canonical trace, capability report, and provenance form a hash-closed bundle.' },
    { label: 'Official esmini execution', status: run?.status === 'succeeded' ? 'passed' : run ? 'failed' : evidence ? 'pending' : 'not-run', detail: run ? `Receipt from pinned esmini ${run.runner.version}: ${run.status}${run.cacheHit ? ' (cache hit)' : ''}.` : evidence ? `Local runner job is ${evidence.snapshot.status}.` : 'No external execution receipt is attached.' },
    { label: 'Behavior parity', status: evidence?.comparison?.verdict === 'pass' ? 'passed' : evidence?.comparison ? 'failed' : 'not-run', detail: evidence?.comparison ? `${evidence.comparison.verdict.toUpperCase()} · ${evidence.comparison.actorMetrics.length} actor tracks · ${evidence.sampleCount ?? 0} synchronized samples.` : 'A verdict is never inferred without a parsed external trace.' },
  ] : snapshot.validation;
  return <div style={styles.list}>{stages.map((stage, index) => <article style={styles.validation} key={stage.label}><div style={styles.step}>{index + 1}</div><div><div style={styles.validationTitle}>{stage.label} <Status status={stage.status} text={stage.status} /></div><p style={styles.copy}>{stage.detail}</p></div></article>)}{run ? <article style={styles.card}><h2 style={styles.cardTitle}>Attached external receipt</h2><Key label="Runner" value={`${run.runner.name} ${run.runner.version}`} /><Key label="Execution" value={run.status} /><Key label="Pinned binary" value={run.runner.digest} /><Key label="Behavior parity" value={evidence?.comparison?.verdict ?? 'not-run'} /></article> : <article style={styles.fileDisabled}><span>No external result is attached. Studio does not infer or mock an esmini verdict.</span><Badge text="Not run" tone="neutral" /></article>}</div>;
}

function ExternalValidation({ bundle, evidence, onRun, onCancel }: { bundle: OpenScenarioLocalBundle | null; evidence: OpenScenarioLocalRunEvidence | null; onRun(): void; onCancel(): void }): JSX.Element {
  if (!bundle) return <Empty title="Build a runnable XML 1.3 bundle first" detail="Select an esmini profile above, then build it before external execution." />;
  const status = evidence?.snapshot.status ?? 'not-run';
  const active = status === 'queued' || status === 'running';
  const result = evidence?.snapshot.result;
  return <div style={styles.list} data-testid="openscenario-external-validation"><article style={styles.card}><div style={styles.runHeader}><div><h2 style={styles.cardTitle}>Pinned local runner</h2><Status status={result?.status === 'succeeded' ? 'passed' : active ? 'pending' : result ? 'failed' : 'not-run'} text={status} /></div><div style={styles.headerActions}>{active ? <button type="button" style={styles.secondaryButton} onClick={onCancel}>Cancel</button> : null}<button type="button" style={styles.primaryButton} onClick={onRun} disabled={active}>{result ? 'Run again' : 'Run official esmini 3.6.0'}</button></div></div><p style={styles.copy}>Runs entirely on localhost at a fixed 0.02 s timestep. The browser cannot provide commands, paths, URLs, or environment variables.</p>{result?.error ? <div style={styles.errorBanner}>{result.error.code}: {result.error.message}</div> : null}{result ? <div style={styles.metricsGrid}><Key label="Duration" value={`${(result.durationMs / 1000).toFixed(2)} s wall clock`} /><Key label="Cache" value={result.cacheHit ? 'verified cache hit' : 'fresh execution'} /><Key label="Exit" value={String(result.exitCode ?? '—')} /><Key label="Isolation" value={result.runner.isolation} /></div> : null}</article>{evidence?.comparisonUi ? <article style={styles.card} data-testid="openscenario-comparison-verdict"><div style={styles.verdictHeader}><div><h2 style={styles.cardTitle}>Quantitative behavior parity</h2><strong style={evidence.comparisonUi.status === 'pass' ? styles.passText : styles.failText}>{evidence.comparisonUi.headline}</strong></div><Badge text={evidence.comparisonUi.status} tone={evidence.comparisonUi.status === 'pass' ? 'good' : 'bad'} /></div><div style={styles.metricCards}>{evidence.comparisonUi.summary.map((item) => <div key={item.label} style={styles.metricCard}><span>{item.label}</span><strong>{item.value}</strong></div>)}</div><div style={styles.table}>{evidence.comparisonUi.actorRows.map((actor) => <div style={styles.actorMetricRow} key={actor.actorId}><code>{actor.actorId}</code><span>{actor.positionP95M.toFixed(3)} m p95</span><span>{actor.headingP95Deg.toFixed(2)}° p95</span><span>{actor.speedP95Mps.toFixed(3)} m/s p95</span><Badge text={actor.status} tone={actor.status === 'ok' ? 'good' : 'bad'} /></div>)}</div></article> : null}{evidence?.dualTrace ? <DualTraceReplay data={evidence.dualTrace} /> : null}{evidence?.unsupportedSemantics.length ? <article style={styles.card}><h2 style={styles.cardTitle}>Scope and unsupported semantics</h2>{evidence.unsupportedSemantics.map((note) => <p style={styles.copy} key={note}>{note}</p>)}</article> : null}{result?.logs.length ? <article style={styles.card}><h2 style={styles.cardTitle}>Runner logs</h2><pre style={styles.log}>{result.logs.map((entry) => `[${entry.level}] ${entry.stream}: ${entry.message}`).join('\n')}</pre></article> : null}</div>;
}

function DualTraceReplay({ data }: { data: NonNullable<OpenScenarioLocalRunEvidence['dualTrace']> }): JSX.Element {
  const [index, setIndex] = useState(0); const [playing, setPlaying] = useState(false);
  useEffect(() => { if (!playing) return; const timer = window.setInterval(() => setIndex((value) => value >= data.frames.length - 1 ? (setPlaying(false), value) : value + 1), 20); return () => window.clearInterval(timer); }, [data.frames.length, playing]);
  const frame = data.frames[index]!;
  return <article style={styles.card} data-testid="openscenario-dual-trace"><div style={styles.runHeader}><div><h2 style={styles.cardTitle}>Synchronized dual-trace replay</h2><strong>{frame.t.toFixed(2)} / {data.durationS.toFixed(2)} s · {data.frames.length.toLocaleString()} samples</strong></div><button type="button" style={styles.secondaryButton} onClick={() => { if (index >= data.frames.length - 1) setIndex(0); setPlaying((value) => !value); }}>{playing ? 'Pause' : 'Play traces'}</button></div><input aria-label="Dual trace time" type="range" min={0} max={data.frames.length - 1} value={index} onChange={(event) => { setPlaying(false); setIndex(Number(event.target.value)); }} style={styles.scrubber} /><div style={styles.table}>{Object.entries(frame.actors).map(([actorId, pose]) => <div style={styles.traceRow} key={actorId}><code>{actorId}</code><span>Canonical {pose.canonical ? `${pose.canonical.x.toFixed(2)}, ${pose.canonical.y.toFixed(2)}` : 'absent'}</span><span>esmini {pose.external ? `${pose.external.x.toFixed(2)}, ${pose.external.y.toFixed(2)}` : 'absent'}</span><strong>{pose.positionErrorM === null ? '—' : `${pose.positionErrorM.toFixed(3)} m`}</strong></div>)}</div></article>;
}

function Files({ snapshot, bundle, evidence }: { snapshot: OpenScenarioSnapshot; bundle: OpenScenarioLocalBundle | null; evidence: OpenScenarioLocalRunEvidence | null }): JSX.Element {
  const items = [
    { kind: 'xml' as const, name: snapshot.artifact.filename, detail: 'Generated OpenSCENARIO XML 1.4 trajectory replay', enabled: !!snapshot.artifact.content },
    { kind: 'input' as const, name: snapshot.artifact.filename.replace('.xosc', '.input.json'), detail: 'Exact materialized SimScenarioInput', enabled: true },
    { kind: 'capability' as const, name: snapshot.artifact.filename.replace('.xosc', '.capabilities.json'), detail: 'Fail-closed per-field fidelity report', enabled: !!snapshot.artifact.capabilityReport },
    { kind: 'manifest' as const, name: snapshot.artifact.filename.replace('.xosc', '.export-manifest.json'), detail: 'Hashes, mapping, dependency and validation evidence', enabled: true },
  ];
  return <div style={styles.list}>{items.map((item) => <article style={styles.file} key={item.kind}><div><strong>{item.name}</strong><div style={styles.muted}>{item.detail}</div></div><button type="button" style={styles.secondaryButton} disabled={!item.enabled} onClick={() => downloadSnapshotFile(snapshot, item.kind)}>Download</button></article>)}{bundle ? <article style={styles.file}><div><strong>{bundle.filename.replace('.xosc', '.bundle.zip')}</strong><div style={styles.muted}>Complete XML 1.3 + OpenDRIVE + trace + provenance runnable bundle</div></div><a style={styles.downloadLink} href={bundle.downloadUrl} download>Download bundle</a></article> : <article style={styles.fileDisabled}><div><strong>{snapshot.map.roadFile}</strong><div style={styles.muted}>Complete immutable OpenDRIVE dependency · resolved only after bundle build</div></div><Badge text="Pending bundle" tone="warn" /></article>}{evidence?.artifacts.map((artifact) => <article style={styles.file} key={artifact.artifactId}><div><strong>{artifact.name}</strong><div style={styles.muted}>{artifact.kind} · {artifact.byteLength.toLocaleString()} bytes · {artifact.authoritative ? 'authoritative evidence' : 'human evidence'}</div></div><a style={styles.downloadLink} href={artifact.downloadUrl} download>Download</a></article>)}<PlannedAuthoringFormats /></div>;
}

function Empty({ title, detail, action, onAction, busy }: { title: string; detail: string; action?: string; onAction?: () => void; busy?: boolean }): JSX.Element { return <div style={styles.empty}>{busy ? <div style={styles.spinner} /> : null}<h2>{title}</h2><p>{detail}</p>{action ? <button type="button" className="studio-btn" style={styles.secondaryButton} onClick={onAction} disabled={!onAction}>{action}</button> : null}</div>; }
function Card({ title, children }: { title: string; children: React.ReactNode }): JSX.Element { return <article style={styles.card}><h2 style={styles.cardTitle}>{title}</h2>{children}</article>; }
function Key({ label, value }: { label: string; value: string }): JSX.Element { return <div style={styles.key}><span>{label}</span><strong>{value}</strong></div>; }
function Hash({ label, value }: { label: string; value: string }): JSX.Element { return <div style={styles.key}><span>{label}</span><code title={value}>{value.slice(0, 12)}…{value.slice(-6)}</code></div>; }
function Badge({ text, tone }: { text: string; tone: 'good' | 'bad' | 'warn' | 'neutral' }): JSX.Element { return <span style={{ ...styles.badge, ...styles[`badge_${tone}`] }}>{text}</span>; }
function Status({ status, text }: { status: string; text: string }): JSX.Element { const tone = status === 'passed' ? 'good' : status === 'failed' ? 'bad' : status === 'pending' ? 'warn' : 'neutral'; return <Badge text={text} tone={tone} />; }
function Segment({ active, onClick, children }: { active: boolean; onClick(): void; children: React.ReactNode }): JSX.Element { return <button type="button" style={{ ...styles.segment, ...(active ? styles.segmentActive : null) }} onClick={onClick}>{children}</button>; }
function label(section: Section): string { return ({ overview: 'Overview', schema: 'Generated schema', compatibility: 'Compatibility', issues: 'Issues', mapping: 'Source mapping', validation: 'Validation', external: 'External replay', files: 'Files' })[section]; }

const GLASS_SURFACE: CSSProperties = {
  background: 'linear-gradient(180deg, var(--ueui-glass-high, rgba(19, 24, 32, 0.92)), var(--ueui-glass-low, rgba(8, 11, 16, 0.94)))',
  backdropFilter: 'blur(72px) saturate(185%)',
  WebkitBackdropFilter: 'blur(72px) saturate(185%)',
};

const styles: Record<string, CSSProperties> = {
  root: { position: 'absolute', inset: 0, zIndex: 40, display: 'flex', ...GLASS_SURFACE, color: 'var(--ueui-text, #f2f2f2)' },
  sidebar: { width: 'clamp(168px, 22vw, 226px)', flex: '0 0 clamp(168px, 22vw, 226px)', minWidth: 0, overflowY: 'auto', padding: '22px 14px', boxSizing: 'border-box', borderRight: '1px solid var(--ueui-line, rgba(255,255,255,.08))', background: 'rgba(8, 11, 16, 0.45)', display: 'flex', flexDirection: 'column' },
  title: { fontSize: 17, fontWeight: 650 }, subtitle: { fontSize: 11, color: 'var(--ueui-text-muted, #9a9a9a)', marginTop: 2 },
  nav: { display: 'flex', flexDirection: 'column', gap: 3, marginTop: 24 },
  navButton: { display: 'flex', justifyContent: 'space-between', padding: '9px 10px', border: 0, borderRadius: 7, color: 'var(--ueui-text-muted, #9a9a9a)', background: 'transparent', font: 'inherit', textAlign: 'left', cursor: 'pointer' },
  navActive: { color: 'var(--ueui-text, #f2f2f2)', background: 'var(--ueui-accent-soft, rgba(232,224,68,.16))' }, count: { minWidth: 18, borderRadius: 9, border: '1px solid var(--ueui-line, rgba(255,255,255,.08))', textAlign: 'center', fontSize: 10 },
  sidebarFoot: { marginTop: 'auto', fontSize: 10, lineHeight: 1.5, color: 'var(--ueui-text-muted, #9a9a9a)' },
  main: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' },
  mainHeader: { height: 78, padding: '0 28px', flex: '0 0 78px', borderBottom: '1px solid var(--ueui-line, rgba(255,255,255,.08))', display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  eyebrow: { color: 'var(--ueui-accent, #e8e044)', fontSize: 10, letterSpacing: '.12em', textTransform: 'uppercase' }, heading: { fontSize: 22, margin: '3px 0 0' },
  headerActions: { display: 'flex', gap: 8, alignItems: 'center' }, closeButton: { border: 0, background: 'transparent', color: 'var(--ueui-text-muted, #9a9a9a)', fontSize: 27, cursor: 'pointer' },
  secondaryButton: { border: '1px solid var(--ueui-line-strong, rgba(255,255,255,.14))', borderRadius: 8, padding: '7px 10px', color: 'var(--ueui-text, #f2f2f2)', background: 'rgba(255,255,255,.05)', font: 'inherit', cursor: 'pointer' },
  body: { flex: 1, minHeight: 0, overflow: 'auto', padding: 28 },
  profileBar: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginBottom: 16, padding: 12, border: '1px solid var(--ueui-line, rgba(255,255,255,.08))', borderRadius: 'var(--ueui-radius, 10px)', background: 'rgba(255,255,255,.03)' },
  profileLabel: { display: 'flex', alignItems: 'center', gap: 9, color: 'var(--ueui-text-muted, #9a9a9a)', fontSize: 11 },
  select: { width: 'min(100%, 340px)', minWidth: 0, padding: '7px 9px' },
  primaryButton: { border: '1px solid transparent', borderRadius: 8, padding: '8px 11px', color: '#10120a', background: 'var(--ueui-accent, #e8e044)', font: 'inherit', fontWeight: 700, cursor: 'pointer' },
  profileHint: { color: 'var(--ueui-text-muted, #9a9a9a)', fontSize: 10 },
  errorBanner: { padding: 12, marginBottom: 14, border: '1px solid rgba(255,107,94,.35)', borderRadius: 'var(--ueui-radius, 10px)', color: 'var(--ueui-danger, #ff6b5e)', background: 'rgba(255,107,94,.1)' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(290px, 1fr))', gap: 14 },
  card: { border: '1px solid var(--ueui-line, rgba(255,255,255,.08))', borderRadius: 'var(--ueui-radius, 10px)', background: 'linear-gradient(180deg, rgba(255,255,255,.035), rgba(255,255,255,.012))', padding: 16 }, cardTitle: { fontSize: 12, color: 'var(--ueui-text-muted, #9a9a9a)', margin: '0 0 12px', textTransform: 'uppercase', letterSpacing: '.06em' },
  copy: { margin: '7px 0 0', color: 'rgba(242,242,242,.78)', lineHeight: 1.55 }, key: { display: 'flex', justifyContent: 'space-between', gap: 15, padding: '5px 0', borderBottom: '1px solid var(--ueui-line, rgba(255,255,255,.08))' },
  fullCard: { border: '1px solid var(--ueui-line, rgba(255,255,255,.08))', borderRadius: 'var(--ueui-radius, 10px)', background: 'linear-gradient(180deg, rgba(255,255,255,.035), rgba(255,255,255,.012))', overflow: 'hidden' }, toolbar: { display: 'flex', gap: 4, alignItems: 'center', padding: 8, borderBottom: '1px solid var(--ueui-line, rgba(255,255,255,.08))' },
  segment: { border: 0, borderRadius: 6, padding: '6px 9px', background: 'transparent', color: 'var(--ueui-text-muted, #9a9a9a)', font: 'inherit', cursor: 'pointer' }, segmentActive: { background: 'var(--ueui-accent-soft, rgba(232,224,68,.16))', color: 'var(--ueui-text, #f2f2f2)' }, readOnly: { marginLeft: 'auto', color: 'var(--ueui-text-muted, #9a9a9a)', fontSize: 10 },
  code: { margin: 0, padding: 18, maxHeight: 'calc(100vh - 190px)', overflow: 'auto', color: 'rgba(242,242,242,.85)', background: 'rgba(8, 11, 16, 0.6)', font: '11px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace', whiteSpace: 'pre' },
  tree: { padding: 10, font: '11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace' }, treeRow: { width: '100%', display: 'flex', gap: 8, alignItems: 'center', minHeight: 27, border: 0, background: 'transparent', color: 'rgba(242,242,242,.85)', font: 'inherit', textAlign: 'left', cursor: 'pointer' }, disclosure: { width: 12, color: 'var(--ueui-text-muted, #9a9a9a)' }, tag: { color: 'var(--ueui-text, #f2f2f2)' }, attrs: { color: 'var(--ueui-warn, #f0a13c)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, childCount: { marginLeft: 'auto', color: 'var(--ueui-text-muted, #9a9a9a)' },
  summaryRow: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', borderBottom: '1px solid var(--ueui-line, rgba(255,255,255,.08))' }, summary: { padding: 15, display: 'flex', flexDirection: 'column', alignItems: 'center', borderRight: '1px solid var(--ueui-line, rgba(255,255,255,.08))' },
  table: { display: 'flex', flexDirection: 'column' }, tableRow: { display: 'grid', gridTemplateColumns: '130px 90px 90px 1fr', gap: 12, alignItems: 'center', padding: '10px 13px', borderBottom: '1px solid var(--ueui-line, rgba(255,255,255,.08))' }, reason: { color: 'var(--ueui-text-muted, #9a9a9a)' },
  esminiRow: { display: 'grid', gridTemplateColumns: '180px 140px 1fr', gap: 12, alignItems: 'center', padding: '10px 13px', borderBottom: '1px solid var(--ueui-line, rgba(255,255,255,.08))' },
  badge: { display: 'inline-flex', alignItems: 'center', width: 'fit-content', borderRadius: 999, padding: '2px 7px', fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em' }, badge_good: { color: 'var(--ueui-ok, #57c785)', background: 'rgba(87,199,133,.14)' }, badge_bad: { color: 'var(--ueui-danger, #ff6b5e)', background: 'rgba(255,107,94,.12)' }, badge_warn: { color: 'var(--ueui-warn, #f0a13c)', background: 'rgba(240,161,60,.12)' }, badge_neutral: { color: 'var(--ueui-text-muted, #9a9a9a)', background: 'rgba(255,255,255,.05)' },
  list: { display: 'flex', flexDirection: 'column', gap: 10 }, issue: { border: '1px solid var(--ueui-line, rgba(255,255,255,.08))', borderRadius: 'var(--ueui-radius, 10px)', background: 'linear-gradient(180deg, rgba(255,255,255,.035), rgba(255,255,255,.012))', padding: 14 }, pathButton: { border: 0, padding: 0, marginTop: 7, background: 'transparent', color: 'var(--ueui-accent, #e8e044)', font: '11px ui-monospace, monospace', cursor: 'pointer', textAlign: 'left' },
  mappingRow: { display: 'grid', gridTemplateColumns: '180px 20px 80px 180px 1fr', gap: 10, alignItems: 'center', padding: '9px 13px', borderBottom: '1px solid var(--ueui-line, rgba(255,255,255,.08))' }, selector: { overflow: 'hidden', textOverflow: 'ellipsis', color: 'var(--ueui-text-muted, #9a9a9a)', font: '10px ui-monospace, monospace' },
  validation: { display: 'grid', gridTemplateColumns: '34px 1fr', gap: 12, padding: 15, border: '1px solid var(--ueui-line, rgba(255,255,255,.08))', borderRadius: 'var(--ueui-radius, 10px)', background: 'linear-gradient(180deg, rgba(255,255,255,.035), rgba(255,255,255,.012))' }, step: { width: 28, height: 28, borderRadius: 14, background: 'rgba(255,255,255,.07)', display: 'grid', placeItems: 'center', fontWeight: 700 }, validationTitle: { display: 'flex', gap: 9, alignItems: 'center', fontWeight: 700 },
  file: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 15, padding: 14, border: '1px solid var(--ueui-line, rgba(255,255,255,.08))', borderRadius: 'var(--ueui-radius, 10px)', background: 'linear-gradient(180deg, rgba(255,255,255,.035), rgba(255,255,255,.012))' }, fileDisabled: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 15, padding: 14, border: '1px dashed var(--ueui-line-strong, rgba(255,255,255,.14))', borderRadius: 'var(--ueui-radius, 10px)', color: 'var(--ueui-text-muted, #9a9a9a)' }, muted: { color: 'var(--ueui-text-muted, #9a9a9a)', fontSize: 10, marginTop: 3 },
  downloadLink: { border: '1px solid var(--ueui-line-strong, rgba(255,255,255,.14))', borderRadius: 8, padding: '7px 10px', color: 'var(--ueui-text, #f2f2f2)', background: 'rgba(255,255,255,.05)', textDecoration: 'none' },
  runHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 },
  verdictHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'start', gap: 12 }, passText: { color: 'var(--ueui-ok, #57c785)', fontSize: 18 }, failText: { color: 'var(--ueui-danger, #ff6b5e)', fontSize: 18 },
  metricsGrid: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '0 20px', marginTop: 14 },
  metricCards: { display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 8, margin: '14px 0' }, metricCard: { padding: 10, borderRadius: 8, background: 'rgba(255,255,255,.04)', display: 'flex', flexDirection: 'column', gap: 4, color: 'var(--ueui-text-muted, #9a9a9a)' },
  actorMetricRow: { display: 'grid', gridTemplateColumns: 'minmax(120px, 1fr) repeat(3, 130px) 60px', gap: 10, alignItems: 'center', padding: '8px 5px', borderTop: '1px solid var(--ueui-line, rgba(255,255,255,.08))' },
  scrubber: { width: '100%', margin: '18px 0', accentColor: 'var(--ueui-accent, #e8e044)' }, traceRow: { display: 'grid', gridTemplateColumns: 'minmax(120px, 1fr) 190px 190px 90px', gap: 12, padding: '8px 5px', borderTop: '1px solid var(--ueui-line, rgba(255,255,255,.08))' },
  log: { maxHeight: 220, overflow: 'auto', padding: 12, borderRadius: 8, background: 'rgba(8, 11, 16, 0.6)', color: 'rgba(242,242,242,.82)', font: '10px/1.55 ui-monospace, monospace', whiteSpace: 'pre-wrap' },
  empty: { minHeight: 300, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', color: 'var(--ueui-text-muted, #9a9a9a)' }, spinner: { width: 28, height: 28, border: '3px solid rgba(255,255,255,.12)', borderTopColor: 'var(--ueui-accent, #e8e044)', borderRadius: '50%', animation: 'spin 1s linear infinite' },
};
