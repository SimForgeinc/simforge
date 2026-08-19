import { render } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { artifactUrl, campaignCaseProgress, CAMPAIGN_ID, getCampaign, getGallery, getJob, submitJob, subscribe } from './api';
import { artifactKind, artifacts, cardId, cardMedia, cells, formatRate, scopeStageArtifacts, stageList, STAGES, threeDVideos } from './model';
import type {
  Artifact, CampaignBenchmark, CampaignCase, CampaignCaseState, CampaignReport, CampaignValidityContract, CampaignVideo,
  GalleryCard, HourlyRate, JobIndex, Rate, StageEvent, SubmitPayload,
} from './types';
import './style.css';

const MAPS = [
  ['yale-street', 'Yale Street'],
  ['belmont-research-center', 'Belmont Research Center'],
  ['el-camino-road', 'El Camino Road'],
  ['easterbrook-discovery-school', 'Easterbrook Discovery School'],
  ['richmond-field-station', 'Richmond Field Station'],
] as const;
const mapLabel = (id: string) => MAPS.find(([mapId]) => mapId === id)?.[1] ?? id;

function navigate(hash: string) { location.hash = hash; }
function useRoute() {
  const [hash, setHash] = useState(location.hash || '#/');
  useEffect(() => { const update = () => setHash(location.hash || '#/'); addEventListener('hashchange', update); return () => removeEventListener('hashchange', update); }, []);
  const job = hash.match(/^#\/jobs\/([^/?]+)/);
  const campaign = hash.match(/^#\/campaigns\/([^/?]+)/);
  if (job) return { view: 'job' as const, id: decodeURIComponent(job[1]) };
  if (campaign) return { view: 'campaign' as const, id: decodeURIComponent(campaign[1]) };
  return hash.startsWith('#/submit') ? { view: 'submit' as const } : { view: 'gallery' as const };
}

function Chip({ children, tone = '', title }: { children: preact.ComponentChildren; tone?: string; title?: string }) { return <span class={`chip ${tone}`} title={title}>{children}</span>; }
function Score({ label, value }: { label: string; value?: number }) { return <Chip>{label} <b>{value == null ? '—' : value.toFixed(1)}</b></Chip>; }
function ErrorBox({ error }: { error: unknown }) { return error ? <div class="error" role="alert">{error instanceof Error ? error.message : String(error)}</div> : null; }

function Header() {
  return <header><button class="brand" onClick={() => navigate('#/')}><span class="brand-mark">U</span><span><b>UniScenarios</b><small>pipeline showcase</small></span></button><nav><button onClick={() => navigate('#/')}>Gallery</button><button onClick={() => navigate(`#/campaigns/${CAMPAIGN_ID}`)}>Campaign</button><button class="primary compact" onClick={() => navigate('#/submit')}>New job</button></nav></header>;
}

function Media({ source, label, loop = false }: { source?: string; label: string; loop?: boolean }) {
  if (!source) return <div class="media placeholder"><span>Render queued</span></div>;
  const url = artifactUrl(source);
  return artifactKind(source) === 'video'
    ? <video class="media" src={url} aria-label={label} muted={loop} autoPlay={loop} loop={loop} playsInline controls={!loop} />
    : <img class="media" src={url} alt={label} loading="lazy" />;
}

function Gallery() {
  const [cards, setCards] = useState<GalleryCard[]>([]); const [error, setError] = useState<unknown>(); const [loading, setLoading] = useState(true);
  useEffect(() => { getGallery().then(setCards).catch(setError).finally(() => setLoading(false)); }, []);
  return <main><section class="hero"><div><p class="eyebrow">EDGE-CASE CORPUS</p><h1>Scenes worth inspecting.</h1><p>Generated scenarios, gate evidence, and rendered behavior—from brief to verdict.</p></div><button class="primary" onClick={() => navigate('#/submit')}>Submit a scenario <span>→</span></button></section><ErrorBox error={error} />
    {loading ? <div class="empty">Loading gallery…</div> : !cards.length ? <div class="empty"><h2>No gallery entries yet</h2><p>Submit the first edge-case prompt to start the pipeline.</p></div> : <section class="gallery" aria-label="Scenario gallery">{cards.map((card) => {
      const id = cardId(card); const admitted = card.admittedCells ?? (typeof card.admitted === 'number' ? card.admitted : 0); const total = card.totalCells ?? card.total ?? 0;
      return <article class="gallery-card" key={id} onClick={() => navigate(`#/jobs/${encodeURIComponent(id)}`)} tabindex={0} onKeyDown={(e) => e.key === 'Enter' && navigate(`#/jobs/${encodeURIComponent(id)}`)}>
        <Media source={cardMedia(card)} label={card.brief ?? 'Scenario render'} loop />
        <div class="card-body"><div class="chip-row"><Chip tone="engine">{card.engine ?? 'auto'}</Chip><Chip tone={admitted ? 'pass' : 'fail'}>{admitted}/{total} admitted</Chip></div><h2>{card.headline ?? card.brief ?? 'Untitled scenario'}</h2>{card.headline && <p>{card.brief}</p>}<div class="chip-row"><Score label="Realism" value={card.realism} /><Score label="Dynamism" value={card.dynamism} /></div><div class="map-row">{card.maps?.map((map) => <Chip key={map}>{mapLabel(map)}</Chip>)}</div></div>
      </article>;
    })}</section>}
  </main>;
}

function ArtifactView({ artifact, filmstrip = false }: { artifact: Artifact; filmstrip?: boolean }) {
  const kind = artifactKind(artifact); const url = artifactUrl(artifact); const label = artifact.name ?? artifact.path ?? artifact.url ?? 'artifact';
  if (kind === 'image') return <a class={filmstrip ? 'film-frame' : 'artifact-image'} href={url} target="_blank"><img src={url} alt={label} loading="lazy" /><span>{label.split('/').pop()}</span></a>;
  if (kind === 'video') return <div class="artifact-video"><video src={url} controls playsInline /><a href={url} download>Download video</a></div>;
  return <a class="download" href={url} download>↓ {label.split('/').pop()}</a>;
}

function StageCard({ event, index }: { event: StageEvent; index: number }) {
  const [number, name] = STAGES[index]; const stageArtifacts = artifacts(event); const isFilmstrip = number === '20' && stageArtifacts.filter((item) => artifactKind(item) === 'image').length > 1;
  return <details class={`stage ${event.status}`} open={event.status === 'running'}><summary><span class="stage-dot" /><span class="stage-number">{number}</span><b>{name}</b><span class="stage-status">{event.status}</span>{event.elapsedMs != null && <span class="elapsed">{(event.elapsedMs / 1000).toFixed(1)}s</span>}<span class="chevron">⌄</span></summary><div class="stage-content">
    {stageArtifacts.length > 0 && <div class={isFilmstrip ? 'filmstrip' : 'artifacts'}>{stageArtifacts.map((item, i) => <ArtifactView key={`${item.path ?? item.url}-${i}`} artifact={item} filmstrip={isFilmstrip} />)}</div>}
    <h4>Raw stage JSON</h4><pre>{JSON.stringify(event, null, 2)}</pre>
  </div></details>;
}

function verdict(value?: boolean) { return value == null ? '—' : value ? 'PASS' : 'FAIL'; }
function CellGrid({ job }: { job: JobIndex | null }) {
  const rows = cells(job); if (!rows.length) return <div class="empty small">Cells appear after simulation.</div>;
  return <div class="cell-grid">{rows.map((cell) => { const gate = typeof cell.gate === 'boolean' ? cell.gate : cell.gate?.pass ?? cell.gate?.admitted; const product = cell.product; return <details class="cell" key={cell.cellId ?? cell.id}><summary><div><small>{cell.map ? mapLabel(cell.map) : 'map'}</small><b>{cell.cellId ?? cell.id}</b></div><Chip tone={gate === true ? 'pass' : gate === false ? 'fail' : ''}>gate {verdict(gate)}</Chip></summary><div class="cell-body"><div class="chip-row"><Chip tone={gate === true ? 'pass' : gate === false ? 'fail' : ''}>gate {verdict(gate)}</Chip><Chip tone={product?.semanticAccepted === true ? 'pass' : product?.semanticAccepted === false ? 'fail' : ''}>semantic {verdict(product?.semanticAccepted)}</Chip><Chip tone={product?.accepted === true ? 'pass' : product?.accepted === false ? 'fail' : ''}>accepted {verdict(product?.accepted)}</Chip>{product?.defectCodes?.map((code) => <Chip tone="fail" key={code}>{code}</Chip>)}</div>{product?.unsupportedReason && <p class="failure">Unsupported: {product.unsupportedReason}</p>}{typeof cell.gate === 'object' && cell.gate.firstFailure && <p class="failure">First failure: {cell.gate.firstFailure}</p>}<div class="artifacts">{artifacts(cell).map((item, i) => <ArtifactView key={i} artifact={item} />)}</div><pre>{JSON.stringify(cell, null, 2)}</pre></div></details>; })}</div>;
}

function ThreeDGallery({ job, status }: { job: JobIndex | null; status: string }) {
  const videos = threeDVideos(job);
  if (!videos.length) {
    const message = status === 'running'
      ? 'Candidate renders stay hidden until simulation, semantic screening, and deterministic 3D rendering complete.'
      : status === 'complete'
        ? 'No 3D candidate satisfied the product decision: the frozen gate and 2D semantic oracle must pass, and the deterministic render must complete. Inspect Pipeline details for defect codes.'
        : 'Accepted 3D videos will appear after gate-passing, semantically matched scenarios finish rendering.';
    return <div class="empty video-empty"><div class="render-pulse" /><h2>Accepted 3D videos</h2><p>{message}</p></div>;
  }
  return <div class="job-video-gallery">{videos.map(({ cell, artifact }) => {
    const id = cell.cellId ?? cell.id ?? 'scenario';
    const source = artifact.path ?? artifact.url ?? '';
    return <article class="job-video-card" key={id}>
      <video src={artifactUrl(source)} aria-label={`Accepted 3D rollout for ${id}`} muted autoPlay loop playsInline controls preload="metadata" />
      <div class="job-video-meta"><div><small>{cell.map ? mapLabel(cell.map) : '3D scenario'}</small><h2>{id}</h2></div><div class="chip-row">
        <Chip tone="pass">2D semantic match + 3D render</Chip>
      </div></div>
    </article>;
  })}</div>;
}

function JobDetail({ id }: { id: string }) {
  const [job, setJob] = useState<JobIndex | null>(null);
  const [live, setLive] = useState<Record<string, StageEvent>>({});
  const [connected, setConnected] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [error, setError] = useState<unknown>();
  const refresh = () => getJob(id).then((value) => { setJob(value); setError(undefined); }).catch(setError);
  useEffect(() => {
    refresh();
    const stop = subscribe(id, (incoming) => {
      const event = scopeStageArtifacts(id, incoming);
      const key = event.stage.match(/\d{2}/)?.[0] ?? event.stage;
      setLive((old) => ({ ...old, [key]: event }));
      if (event.status === 'complete' || event.status === 'failed') refresh();
    }, setConnected);
    return stop;
  }, [id]);
  const stages = useMemo(() => stageList(job, live), [job, live]);
  const completed = stages.filter((stage) => stage.status === 'complete').length;
  return <main><button class="back" onClick={() => navigate('#/')}>← Gallery</button>
    <section class="job-heading"><div><div class="chip-row"><Chip tone="engine">{job?.engine ?? (job?.options?.engine as string) ?? 'routing'}</Chip><Chip>{(job?.options?.methodology as string) ?? 'custom'}</Chip><Chip tone={connected ? 'live' : ''}><span class="live-dot" />{connected ? 'live' : 'reconnecting'}</Chip><Chip>{job?.status ?? 'in progress'}</Chip></div><h1>{job?.brief ?? (job?.options?.brief as string) ?? `Job ${id}`}</h1><p class="mono">{id}</p></div><button onClick={refresh}>Refresh</button></section>
    <ErrorBox error={error} />
    <section class="video-gallery-section"><div class="section-title"><div><p class="eyebrow">3D OUTPUT</p><h2>Your scenario videos</h2></div><p>{completed}/{STAGES.length} pipeline stages complete. Videos appear here automatically.</p></div><ThreeDGallery job={job} status={stages[9]?.status ?? 'pending'} /></section>
    <button class="details-toggle" aria-expanded={showDetails} onClick={() => setShowDetails((value) => !value)}>{showDetails ? 'Hide pipeline details' : 'Show pipeline details'} <span>{showDetails ? '↑' : '↓'}</span></button>
    {showDetails && <div class="pipeline-details">
      <section><div class="section-title"><div><p class="eyebrow">PIPELINE DETAILS</p><h2>Intermediate stages</h2></div><p>Optional diagnostics: inspect exact outputs and artifacts from every stage.</p></div><div class="timeline">{stages.map((event, i) => <StageCard event={event} index={i} key={STAGES[i][0]} />)}</div></section>
      <section><div class="section-title"><div><p class="eyebrow">CELL DETAILS</p><h2>Gate and semantic oracle evidence</h2></div><p>Optional per-location gate, semantic, and deterministic render verdicts.</p></div><CellGrid job={job} /></section>
    </div>}
  </main>;
}

const compactCount = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const plainCount = new Intl.NumberFormat('en');
function duration(seconds?: number) {
  if (!seconds || seconds < 0) return '—';
  if (seconds < 90) return `${Math.round(seconds)}s`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds - hours * 3600) / 60);
  return hours ? `${hours}h ${String(minutes).padStart(2, '0')}m` : `${minutes}m`;
}
function ago(iso?: string) {
  const elapsed = iso ? Date.now() - Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(elapsed)) return '';
  const minutes = Math.round(elapsed / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

function Meter({ value, max, label }: { value: number; max: number; label: string }) {
  const percent = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return <div class="meter" role="progressbar" aria-label={label} aria-valuenow={value} aria-valuemin={0} aria-valuemax={max}><i style={{ width: `${percent.toFixed(2)}%` }} /></div>;
}
function Stat({ label, value, hint, children }: { label: string; value: string; hint?: string; children?: preact.ComponentChildren }) {
  return <div class="stat"><small>{label}</small><b>{value}</b>{children}{hint && <span>{hint}</span>}</div>;
}
function Pips({ value, max }: { value: number; max: number }) {
  return <span class="pips" role="img" aria-label={`${value} of ${max} accepted videos`}>{Array.from({ length: max }, (_, index) => <span key={index} class={index < value ? 'pip on' : 'pip'} />)}</span>;
}

const BENCHMARK_OUTCOMES = ['accepted', 'attempting', 'exhausted', 'unsupported', 'pending'] as const;
function benchmarkSeconds(value: number | null) {
  return value === null ? 'n/a' : `${value.toFixed(1)}s`;
}
function formatWilson(rate: Rate | null | undefined) {
  if (!rate || rate.denominator === 0 || rate.value === null || rate.wilson95 === null) return 'n/a';
  return `${(rate.wilson95.low * 100).toFixed(1)}–${(rate.wilson95.high * 100).toFixed(1)}%`;
}
/** The percentage alone, for tables that already show `reached/denominator`. */
function formatPercent(rate: Rate | null | undefined) {
  if (!rate || rate.denominator === 0 || rate.value === null) return 'n/a';
  return `${(rate.value * 100).toFixed(1)}%`;
}
/**
 * A per-hour rate is meaningless without the window it was divided by, so an
 * unmeasured window renders as `n/a` rather than an extrapolated number.
 */
function formatHourly(rate: HourlyRate, unit: string) {
  if (rate.value === null || !rate.denominatorHours) return `n/a ${unit}`;
  return `${rate.value.toFixed(2)} ${unit}`;
}
function hourlyHint(rate: HourlyRate) {
  return !rate.denominatorHours
    ? 'observation window too short to sustain a rate'
    : `${rate.numerator} over ${rate.denominatorHours.toFixed(3)} h`;
}
function BenchmarkHistogram({ label, values }: { label: string; values: Record<string, number> }) {
  return <div><small>{label}</small><div class="chip-row">{Object.entries(values).map(([name, count]) => <Chip key={name}>{count} × {name}</Chip>)}</div></div>;
}
function BenchmarkPanel({ benchmark }: { benchmark?: CampaignBenchmark }) {
  if (!benchmark) return <p class="benchmark-unpublished">This campaign has not published benchmark evidence yet.</p>;
  const { corpus, funnel, throughput, execution, diversity, operational } = benchmark;
  return <section class="benchmark-panel" aria-labelledby="benchmark-title">
    <div class="section-title">
      <div><p class="eyebrow">BENCHMARK EVIDENCE</p><h2 id="benchmark-title">Stage-separated evidence</h2></div>
      <p>Measured conversion, throughput, diversity, and censored operational evidence.</p>
    </div>
    <div class="benchmark-block">
      <h3>Corpus accounting</h3>
      <div class="chip-row">
        {BENCHMARK_OUTCOMES.map((outcome) => <Chip key={outcome}>{corpus.outcomes[outcome]}/{corpus.entries} {outcome}</Chip>)}
        {!corpus.accountedFor && <Chip tone="fail">accounting mismatch</Chip>}
      </div>
    </div>
    <div class="benchmark-block">
      <h3>Funnel</h3>
      <div class="benchmark-table-wrap">
        <table class="benchmark-table">
          <thead><tr><th>Stage</th><th>Phase</th><th>Reached / denominator</th><th>Step rate</th><th>Wilson 95%</th><th>Censored here</th></tr></thead>
          <tbody>{funnel.stages.map((stage) => <tr key={stage.id}>
            <td><b>{stage.label}</b><small>denominator: {stage.denominatorStage} · evidence: {stage.evidence}</small></td>
            <td>{stage.phase}</td>
            <td>{stage.reached}/{stage.denominator}</td>
            <td>{formatPercent(stage.stepRate)}</td>
            <td>{formatWilson(stage.stepRate)}</td>
            <td>{stage.censoredHere}</td>
          </tr>)}</tbody>
        </table>
      </div>
    </div>
    <div class="benchmark-throughput">
      <div class="benchmark-block">
        <h3>Generator</h3>
        <p class="benchmark-boundary">generator throughput ends at deterministic eligibility</p>
        <div class="stat-grid benchmark-stats">
          <Stat label="Eligible yield" value={formatRate(throughput.generator.yield)} />
          <Stat label="Gate yield" value={formatRate(throughput.generator.gateYield)} />
          <Stat label="Eligible attempts/hour" value={formatHourly(throughput.generator.eligibleAttemptsPerHour, 'attempts/h')} hint={hourlyHint(throughput.generator.eligibleAttemptsPerHour)} />
          <Stat label="Eligible cells/hour" value={formatHourly(throughput.generator.eligibleCellsPerHour, 'cells/h')} hint={hourlyHint(throughput.generator.eligibleCellsPerHour)} />
          <Stat label="Wall p50" value={benchmarkSeconds(throughput.generator.wallS.p50)} hint={`p90 ${benchmarkSeconds(throughput.generator.wallS.p90)}`} />
        </div>
      </div>
      <div class="benchmark-block">
        <h3>Product</h3>
        <p class="benchmark-boundary">product throughput adds semantic screening and rendering</p>
        <div class="stat-grid benchmark-stats">
          <Stat label="Yield" value={formatRate(throughput.product.yield)} />
          <Stat label="Accepted attempts/hour" value={formatHourly(throughput.product.acceptedAttemptsPerHour, 'attempts/h')} hint={hourlyHint(throughput.product.acceptedAttemptsPerHour)} />
          <Stat label="Accepted cells/hour" value={formatHourly(throughput.product.acceptedCellsPerHour, 'cells/h')} hint={hourlyHint(throughput.product.acceptedCellsPerHour)} />
          <Stat label="Wall p50" value={benchmarkSeconds(throughput.product.wallS.p50)} hint={`p90 ${benchmarkSeconds(throughput.product.wallS.p90)}`} />
        </div>
      </div>
    </div>
    <div class="benchmark-block">
      <h3>Execution conditions</h3>
      <div class="stat-grid benchmark-stats">
        <Stat
          label="Cold vs warm"
          value={formatRate(execution.cold)}
          hint={`${execution.cold.denominator - execution.cold.numerator} warm · ${execution.cold.denominator} measured`}
        />
        <Stat label="Resumed attempts" value={formatRate(execution.resumed)} />
        <Stat label="Active jobs at start" value={execution.concurrency.activeJobsAtStart.p50 === null ? 'n/a' : `p50 ${execution.concurrency.activeJobsAtStart.p50.toFixed(1)}`} hint={`peak p90 ${execution.concurrency.peakActiveJobs.p90 ?? 'n/a'}`} />
        <Stat label="Host load at start" value={execution.concurrency.load1AtStart.p50 === null ? 'n/a' : `p50 ${execution.concurrency.load1AtStart.p50.toFixed(2)}`} hint={`simulation p50 ${execution.concurrency.load1AtSimulation.p50 ?? 'n/a'}`} />
      </div>
      <BenchmarkHistogram label="Logical CPUs" values={execution.concurrency.logicalCpus} />
      <BenchmarkHistogram label="Schedulers" values={execution.concurrency.scheduler} />
      <BenchmarkHistogram label="Author model / effort" values={execution.models.author} />
      <BenchmarkHistogram label="Engine requested" values={execution.models.engineRequested} />
      <BenchmarkHistogram label="Engine resolved" values={execution.models.engineResolved} />
    </div>
    <div class="benchmark-block">
      <h3>Diversity</h3>
      <div class="stat-grid benchmark-diversity">
        <Stat label="Trace fingerprints" value={`${diversity.distinctTrajectoryFingerprints}/${diversity.videos}`} hint={`${diversity.unfingerprintedVideos} videos unfingerprinted`} />
        <Stat label="Re-encode-only duplicates" value={plainCount.format(diversity.reencodedOnlyVideos)} />
        <Stat label="Map coverage" value={formatRate(diversity.maps.coverage)} />
        <Stat label="Distinct sites" value={plainCount.format(diversity.sites.distinct)} />
        <Stat label="Pairwise shape distance p50" value={diversity.pairwise.shapeM.p50 === null ? 'n/a' : `${diversity.pairwise.shapeM.p50.toFixed(3)}m`} />
      </div>
      <p class="benchmark-note">{diversity.note}</p>
    </div>
    <div class="benchmark-block benchmark-operational">
      <h3>Operational</h3>
      <p><b>{plainCount.format(operational.attempts)} censored attempts.</b> Operational failures are excluded from the generation denominator but reported.</p>
      <div class="chip-row">{Object.entries(operational.byClass).map(([name, count]) => <Chip key={name}>{count}/{operational.attempts} {name}</Chip>)}</div>
    </div>
  </section>;
}

function AcceptedVideo({ video, caseTitle, heading }: { video: CampaignVideo; caseTitle: string; heading: string }) {
  const jobId = video.jobId;
  return <article class="job-video-card campaign-video-card">
    <video src={artifactUrl(video.url)} aria-label={`Accepted 3D video for ${caseTitle}`} controls playsInline preload="metadata" muted loop />
    <div class="job-video-meta">
      <div><small>{video.mapId ? mapLabel(video.mapId) : 'accepted 3D render'}</small><h2 title={heading}>{heading}</h2></div>
      <div class="chip-row"><Chip tone="pass">2D semantic match + 3D render</Chip></div>
    </div>
    <div class="campaign-video-foot">
      <span title={`sha256 ${video.sha256}${video.acceptedAt ? ` · accepted ${new Date(video.acceptedAt).toLocaleString()}` : ''}`}>{video.acceptedAt ? `accepted ${ago(video.acceptedAt)} · ` : ''}sha {video.sha256.slice(0, 10)}</span>
      {jobId && <button class="ghost-link" onClick={() => navigate(`#/jobs/${encodeURIComponent(jobId)}`)}>Inspect job evidence →</button>}
    </div>
  </article>;
}

const CASE_STATE: Record<CampaignCaseState, [label: string, tone: string]> = {
  complete: ['complete', 'pass'], running: ['rendering', 'live'], blocked: ['needs retry', 'fail'],
  idle: ['pending', ''], unsupported: ['unsupported', 'fail'],
};
// The runner's own outcome wins when it is published: it distinguishes an
// exhausted attempt budget and a deterministic unsupported blocker from a case
// that merely has a failed attempt.
const OUTCOME_LABEL: Record<string, string> = {
  accepted: 'complete', attempting: 'attempting', exhausted: 'attempts exhausted',
  unsupported: 'unsupported', pending: 'pending',
};
const ATTEMPT_TONE: Record<string, string> = { complete: 'pass', failed: 'fail', running: 'live', queued: '' };

function CampaignCaseRow({ item, target }: { item: CampaignCase; target: number }) {
  const progress = campaignCaseProgress(item, target);
  const [label, tone] = CASE_STATE[progress.state];
  const stateLabel = progress.outcome
    ? OUTCOME_LABEL[progress.outcome] ?? label
    : progress.state === 'idle' && progress.attempts > 0 ? 'awaiting attempt' : label;
  const [open, setOpen] = useState(false);
  return <details class={`campaign-case ${progress.state}`} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>
      <span class="case-index">{String(item.index + 1).padStart(2, '0')}</span>
      <b>{item.title}</b>
      <Pips value={progress.accepted} max={target} />
      <span class="case-count">{progress.accepted}/{target}</span>
      <Chip tone={tone} title={progress.unsupportedReason ?? undefined}>{stateLabel}</Chip>
      <span class="chevron">⌄</span>
    </summary>
    {open && <div class="case-body">
      {progress.accepted > 0
        ? <div class="job-video-gallery campaign-videos">{item.validVideos.map((video) => <AcceptedVideo key={video.sha256} video={video} caseTitle={item.title} heading={video.cellId ?? `sha ${video.sha256.slice(0, 12)}`} />)}</div>
        : <p class="case-note">No attempt has cleared strict acceptance for this case yet. Attempts below are status only—rejected or failed renders are never shown as results.</p>}
      <div class="attempt-head"><h4>Attempts</h4><span>{progress.attempts} submitted · {progress.active} in flight · {progress.failed} failed</span></div>
      {progress.attempts === 0
        ? <p class="case-note">Waiting for the campaign runner to submit the first attempt.</p>
        : <ol class="attempt-list">{item.attempts.map((attempt) => <li key={attempt.number} class={attempt.status}>
          <span class="attempt-number">#{attempt.number}</span>
          <Chip tone={ATTEMPT_TONE[attempt.status] ?? ''}>{attempt.status}</Chip>
          <button class="ghost-link mono" onClick={() => navigate(`#/jobs/${encodeURIComponent(attempt.jobId)}`)}>{attempt.jobId}</button>
          <span class="attempt-meta">{attempt.status === 'running' || attempt.status === 'queued' ? 'in flight' : duration(attempt.metrics?.wallS)}</span>
          {attempt.error && <span class="failure">{attempt.error}</span>}
        </li>)}</ol>}
    </div>}
  </details>;
}

const CONTRACT_LABELS: Record<string, string> = {
  semanticAcceptedRequired: '2D semantic match',
  acceptedRequired: 'product accepted',
  frozenGateRequired: 'frozen C1–C6 gate',
  briefAware2dSemanticOracleRequired: 'brief-aware 2D semantic oracle',
  currentProductContractRequired: 'current product contract',
  uniqueVideoSha256Required: 'unique MP4 SHA-256',
  distinctTrajectoryFingerprintRequired: 'distinct trace fingerprint',
};
const CASE_FILTERS = [['all', 'All cases'], ['open', 'In progress'], ['complete', 'Complete']] as const;
type CaseFilter = (typeof CASE_FILTERS)[number][0];

function Campaign({ id }: { id: string }) {
  const [report, setReport] = useState<CampaignReport | null>(null);
  const [error, setError] = useState<unknown>();
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<CaseFilter>('all');
  const load = () => getCampaign(id).then((value) => { setReport(value); setError(undefined); }).catch(setError).finally(() => setLoading(false));
  useEffect(() => {
    setReport(null);
    setError(undefined);
    setLoading(true);
    load();
    const timer = setInterval(load, 30_000);
    return () => clearInterval(timer);
  }, [id]);
  const target = report?.targetValidVideos ?? 0;
  const cases = report?.cases ?? [];
  const visible = useMemo(() => cases.filter((item) => {
    if (filter === 'complete') return item.validVideos.length >= target;
    if (filter === 'open') return item.validVideos.length < target;
    return true;
  }), [cases, filter, target]);
  const latest = useMemo(() => cases
    .flatMap((item) => item.validVideos.map((video) => ({ video, title: item.title })))
    .sort((left, right) => (right.video.acceptedAt ?? '').localeCompare(left.video.acceptedAt ?? ''))
    .slice(0, 6), [cases]);
  const totals = report?.totals;
  const contract = report?.validityContract ?? {};
  const allTokens = totals ? totals.tokens.inputTokens + totals.tokens.outputTokens + totals.tokens.reasoningTokens : 0;
  return <main class="campaign-page">
    <section class="hero campaign-hero">
      <div>
        <p class="eyebrow">STRICT-ACCEPTANCE CAMPAIGN</p>
        <h1>{totals ? `${totals.cases} edge cases, ${target} accepted videos each.` : 'Edge-case campaign progress.'}</h1>
        <p>A render counts only when the frozen gate passes, the brief-aware 2D semantic oracle marks it <span class="mono">semanticAccepted</span>, the deterministic 3D render completes, and the product decision marks it <span class="mono">accepted</span> under the current product contract. Its MP4 hash must also be new within the case. Everything else stays an attempt—never a result.</p>
      </div>
      <div class="campaign-sync">
        <Chip tone={error ? 'fail' : 'live'}><span class="live-dot" />{error ? 'refresh failing' : 'auto-refresh 30s'}</Chip>
        <p class="mono">{report?.updatedAt ? `report published ${new Date(report.updatedAt).toLocaleTimeString()}` : 'no report yet'}</p>
        <button onClick={load}>Refresh now</button>
      </div>
    </section>
    <ErrorBox error={error} />
    {!report || !totals ? (loading
      ? <div class="empty">Loading campaign report…</div>
      : <div class="empty"><h2>No campaign report yet</h2><p>Results appear once the runner publishes <span class="mono">report.json</span> for <span class="mono">{id}</span>. This page retries every 30 seconds.</p></div>) : <>
      <section class="stat-grid" aria-label="Campaign totals">
        <div class="stat lead">
          <small>Accepted videos</small>
          <b>{plainCount.format(totals.validVideos)}<em>/{plainCount.format(totals.targetVideos)}</em></b>
          <Meter value={totals.validVideos} max={totals.targetVideos} label="Accepted videos against strict target" />
          <span>{totals.targetVideos ? ((totals.validVideos / totals.targetVideos) * 100).toFixed(1) : '0.0'}% of the strict target · {duration(totals.elapsedHours * 3600)} elapsed</span>
        </div>
        <Stat label="Complete cases" value={`${totals.completeCases}/${totals.cases}`} hint={`${target} accepted videos required per case`}>
          <Meter value={totals.completeCases} max={totals.cases} label="Cases at full acceptance" />
        </Stat>
        <Stat label="Jobs submitted" value={plainCount.format(totals.jobs)} hint={`${totals.activeJobs} in flight · ${totals.failedJobs} failed · ${duration(totals.wallS)} job wall time`} />
        <Stat label="Throughput" value={formatHourly(totals.validVideosPerHour, 'videos/h')} hint={`${formatHourly(totals.jobsPerHour, 'jobs/h')} · ${hourlyHint(totals.validVideosPerHour)}`} />
        <Stat label="Model tokens" value={compactCount.format(allTokens)} hint={`${compactCount.format(totals.tokens.inputTokens)} in · ${compactCount.format(totals.tokens.outputTokens)} out · ${compactCount.format(totals.tokens.reasoningTokens)} reasoning`} />
        <Stat label="Tokens per accepted video" value={totals.meanTokensPerValidVideo == null ? '—' : compactCount.format(totals.meanTokensPerValidVideo)} hint={`${plainCount.format(totals.tokens.calls)} model calls · ${duration(totals.tokens.modelWallS)} model time`} />
      </section>
      <BenchmarkPanel benchmark={totals.benchmark} />
      <section class="contract-note">
        <p class="eyebrow">VALIDITY CONTRACT</p>
        <div class="chip-row">
          {Object.entries(CONTRACT_LABELS).filter(([key]) => contract[key as keyof CampaignValidityContract] === true).map(([key, label]) => <Chip tone="pass" key={key}>{label}</Chip>)}
          <Chip>≥ {contract.minimumPerCase ?? target} per case</Chip>
        </div>
        <p>Only videos satisfying every clause are playable below. Pending, rejected, and failed attempts appear as status with links to their raw pipeline evidence.</p>
      </section>
      <section>
        <div class="section-title"><div><p class="eyebrow">ACCEPTED RESULTS</p><h2>Latest accepted 3D videos</h2></div><p>Newest acceptances first. Every case keeps its full accepted set in the ledger below.</p></div>
        {latest.length
          ? <div class="job-video-gallery campaign-videos">{latest.map(({ video, title }) => <AcceptedVideo key={video.sha256} video={video} caseTitle={title} heading={title} />)}</div>
          : <div class="empty video-empty"><div class="render-pulse" /><h2>No accepted videos yet</h2><p>{totals.jobs
            ? `${plainCount.format(totals.jobs)} attempts submitted, ${totals.activeJobs} still running. A video appears the moment it clears the gate, 2D semantic oracle, and deterministic 3D render.`
            : 'The campaign runner has not submitted its first attempt yet.'}</p></div>}
      </section>
      <section>
        <div class="section-title"><div><p class="eyebrow">CASE LEDGER</p><h2>Per-case progress</h2></div><div class="filter-row" role="group" aria-label="Filter cases">{CASE_FILTERS.map(([value, label]) => <button key={value} class={filter === value ? 'filter on' : 'filter'} aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>)}</div></div>
        {visible.length ? <div class="campaign-ledger">{visible.map((item) => <CampaignCaseRow key={item.id} item={item} target={target} />)}</div> : <div class="empty small">No cases match this filter.</div>}
      </section>
    </>}
  </main>;
}

const initial: SubmitPayload = { brief: '', methodology: 'production', engine: 'auto', nScenarios: 3, maps: MAPS.map(([id]) => id), maxSitesPerMap: 3, ambient: 'light', seed: 42, render3d: true, topK: 3 };
function Submit() {
  const [form, setForm] = useState(initial); const [busy, setBusy] = useState(false); const [error, setError] = useState<unknown>();
  const update = <K extends keyof SubmitPayload>(key: K, value: SubmitPayload[K]) => setForm((old) => ({ ...old, [key]: value }));
  const send = async (e: Event) => { e.preventDefault(); setBusy(true); setError(undefined); try { navigate(`#/jobs/${encodeURIComponent(await submitJob(form))}`); } catch (reason) { setError(reason); setBusy(false); } };
  const production = form.methodology === 'production';
  const cellCount = production ? 45 : form.maps.length * form.maxSitesPerMap * form.nScenarios;
  return <main class="submit-page"><button class="back" onClick={() => navigate('#/')}>← Gallery</button><section class="submit-intro"><p class="eyebrow">NEW PIPELINE JOB</p><h1>Author an edge case.</h1><p>Production mode runs the measured development recipe—not a shortened demo path. Expect several minutes for compilation, simulation, 2D semantic screening, and deterministic 3D rendering; visual fallback can take longer.</p></section><ErrorBox error={error} /><form onSubmit={send}>
    <fieldset class="wide"><legend>Run methodology</legend><div class="map-options">
      <label class="check"><input type="radio" name="methodology" checked={production} onChange={() => update('methodology', 'production')} /><span><b>Production recipe</b><small>Research-proven routing, sampling, gate, 2D semantic oracle, deterministic 3D rendering, and evidence-driven fallback.</small></span></label>
      <label class="check"><input type="radio" name="methodology" checked={!production} onChange={() => update('methodology', 'custom')} /><span><b>Custom experiment</b><small>Expose individual controls for debugging and ablations.</small></span></label>
    </div></fieldset>
    <label class="wide"><span>Scenario brief</span><textarea required minlength={12} value={form.brief} onInput={(e) => update('brief', e.currentTarget.value)} placeholder="A delivery van blocks the bike lane just before an intersection as a cyclist approaches…" /></label>
    {production ? <section class="wide methodology-card" aria-label="Production methodology">
      <p class="eyebrow">FROZEN PRODUCTION PROFILE</p><h2>Compiler first. Visual author for structural gaps.</h2>
      <p>The server—not this browser—enforces all five maps, three sites per map, three deterministic draws, light ambient traffic, Sol/low authoring, the unchanged C1–C6 gate, brief-aware 2D semantic screening, and deterministic 3D rendering. A rejected compiler result escalates to the visual author; a rejected visual result receives one evidence-driven repair.</p>
      <div class="chip-row"><Chip>5 maps</Chip><Chip>45 cells max</Chip><Chip>light ambient</Chip><Chip>3D top 3</Chip><Chip>visual fallback</Chip></div>
    </section> : <div class="form-grid"><label><span>Engine</span><select value={form.engine} onChange={(e) => update('engine', e.currentTarget.value as SubmitPayload['engine'])}><option value="auto">Auto route</option><option value="compiler">Compiler</option><option value="vista2">Vista2 visual agent</option></select></label>
      <label><span>Scenarios / site</span><input type="number" min="1" max="10" value={form.nScenarios} onInput={(e) => update('nScenarios', e.currentTarget.valueAsNumber)} /></label>
      <label><span>Max sites / map</span><input type="number" min="1" max="10" value={form.maxSitesPerMap} onInput={(e) => update('maxSitesPerMap', e.currentTarget.valueAsNumber)} /></label>
      <label><span>Ambient traffic</span><select value={form.ambient} onChange={(e) => update('ambient', e.currentTarget.value as SubmitPayload['ambient'])}>{['off', 'light', 'moderate', 'city', 'heavy'].map((v) => <option value={v}>{v}</option>)}</select></label>
      <label><span>Seed</span><input type="number" value={form.seed} onInput={(e) => update('seed', e.currentTarget.valueAsNumber)} /></label>
      <fieldset class="wide"><legend>Maps</legend><div class="map-options">{MAPS.map(([id, label]) => <label class="check" key={id}><input type="checkbox" checked={form.maps.includes(id)} onChange={(e) => update('maps', e.currentTarget.checked ? [...form.maps, id] : form.maps.filter((value) => value !== id))} /><span>{label}</span></label>)}</div></fieldset>
      <label class="toggle"><input type="checkbox" checked={form.render3d} onChange={(e) => update('render3d', e.currentTarget.checked)} /><span><b>3D rendering</b><small>Render highest-ranked passing cells</small></span></label>
      <label><span>3D top K</span><input type="number" min="1" max="10" disabled={!form.render3d} value={form.topK} onInput={(e) => update('topK', e.currentTarget.valueAsNumber)} /></label>
    </div>}<div class="submit-actions"><span>{production ? 'Frozen research recipe' : `${form.maps.length} maps`} · up to {cellCount} cells</span><button class="primary" disabled={busy || (!production && !form.maps.length)}>{busy ? 'Submitting…' : 'Start pipeline →'}</button></div>
  </form></main>;
}

function App() {
  const route = useRoute();
  return <><Header />
    {route.view === 'job' ? <JobDetail id={route.id} />
      : route.view === 'campaign' ? <Campaign id={route.id} />
        : route.view === 'submit' ? <Submit /> : <Gallery />}
    <footer>UniScenarios · intermediate outputs preserved stage by stage</footer></>;
}

render(<App />, document.getElementById('app')!);
