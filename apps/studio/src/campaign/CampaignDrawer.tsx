import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { ScenarioTemplateV2 } from '@uniscenarios/scenario-model';
import { mapById } from '../maps';
import type { PlaybackBundle } from '@uniscenarios/playback';
import { CAMERA_EXTENSION_KEY, parseCameraPresentation, type CameraPresentation } from '@uniscenarios/camera-rig';
import { GENERATED_CAMPAIGN_DIAGNOSTICS, GENERATED_CAMPAIGN_ENTRIES } from './generated';
import { filterGalleryEntries, galleryDetails, hasVerifiedVariation, type GalleryFilter } from './gallery';
import {
  campaignImports,
  importAllCampaignEntries,
  importCampaignEntry,
  isCampaignReady,
  loadCampaignEvidence,
  loadCampaignTemplate,
  loadSavedCampaign,
} from './catalog';
import type { CampaignImportRecord, GeneratedCampaignEntry } from './types';

export interface CampaignOpenRequest {
  entry: GeneratedCampaignEntry;
  template: ScenarioTemplateV2;
  savedName: string;
  evidence: PlaybackBundle;
  reuseVerifiedEvidence: boolean;
}

export interface CampaignEvidenceRequest {
  entry: GeneratedCampaignEntry;
  evidence: PlaybackBundle;
  /** Presentation-only view; never written into the verified evidence. */
  cameraPresentation: CameraPresentation;
}

interface RuntimeDetails {
  actors: number;
  duration: number;
}

const FILTERS: readonly { id: GalleryFilter; label: string }[] = [
  { id: 'all', label: 'All scenarios' },
  { id: 'ambient', label: 'Ambient verified' },
  { id: 'variations', label: 'Transfer verified' },
  { id: 'saved', label: 'My saved copies' },
];

export function CampaignDrawer({
  authoringEnabled,
  onOpen,
  onPlayEvidence,
  onClose,
}: {
  authoringEnabled: boolean;
  onOpen: (request: CampaignOpenRequest) => void;
  onPlayEvidence: (request: CampaignEvidenceRequest) => void;
  onClose: () => void;
}): JSX.Element {
  const [imports, setImports] = useState<CampaignImportRecord[]>(() => campaignImports());
  const [busy, setBusy] = useState<string | 'all' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [verified, setVerified] = useState<Set<string>>(() => new Set());
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<GalleryFilter>('all');
  const [mapFilter, setMapFilter] = useState('all');
  const [runtimeDetails, setRuntimeDetails] = useState<Map<string, RuntimeDetails>>(() => new Map());
  const [detailsLoading, setDetailsLoading] = useState(true);
  const searchRef = useRef<HTMLInputElement>(null);
  const importedByStableId = useMemo(() => new Map(imports.map((item) => [item.stableId, item])), [imports]);
  const allReady = GENERATED_CAMPAIGN_ENTRIES.length === 12
    && GENERATED_CAMPAIGN_ENTRIES.every(isCampaignReady);
  const visibleEntries = useMemo(
    () => filterGalleryEntries(GENERATED_CAMPAIGN_ENTRIES, query, filter, mapFilter, imports),
    [filter, imports, mapFilter, query],
  );
  const locations = useMemo(() => [...new Set(GENERATED_CAMPAIGN_ENTRIES.map((entry) => entry.mapId).filter((id): id is string => !!id))], []);

  useEffect(() => {
    if (!authoringEnabled) onClose();
  }, [authoringEnabled, onClose]);

  useEffect(() => {
    let cancelled = false;
    setDetailsLoading(true);
    void Promise.allSettled(GENERATED_CAMPAIGN_ENTRIES.map(async (entry) => {
      const template = await loadCampaignTemplate(entry);
      return [entry.stableId, { actors: template.roles.length, duration: template.choreography.clipSeconds }] as const;
    })).then((results) => {
      if (cancelled) return;
      const next = new Map<string, RuntimeDetails>();
      for (const result of results) if (result.status === 'fulfilled') next.set(...result.value);
      setRuntimeDetails(next);
      setDetailsLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
      if (event.key === '/' && !event.metaKey && !event.ctrlKey && !event.altKey) {
        const target = event.target as HTMLElement | null;
        if (target?.tagName.toLowerCase() !== 'input') {
          event.preventDefault();
          searchRef.current?.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const openEntry = async (entry: GeneratedCampaignEntry): Promise<void> => {
    setBusy(entry.stableId);
    setError(null);
    try {
      const { template, evidence, record } = await importCampaignEntry(entry);
      setVerified((current) => new Set(current).add(entry.stableId));
      setImports(campaignImports());
      onOpen({ entry, template, savedName: record.savedName, evidence, reuseVerifiedEvidence: true });
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setBusy(null); }
  };

  const reopen = async (expected: GeneratedCampaignEntry, record: CampaignImportRecord): Promise<void> => {
    setBusy(expected.stableId);
    setError(null);
    try {
      if (record.stableId !== expected.stableId) throw new Error(`Saved scenario mapping is corrupt for ${expected.title}`);
      const evidence = await loadCampaignEvidence(expected);
      const { entry, template } = await loadSavedCampaign(record, expected);
      setVerified((current) => new Set(current).add(entry.stableId));
      onOpen({ entry, template, savedName: record.savedName, evidence, reuseVerifiedEvidence: false });
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setBusy(null); }
  };

  const playEvidence = async (entry: GeneratedCampaignEntry): Promise<void> => {
    setBusy(entry.stableId);
    setError(null);
    try {
      const [evidence, template] = await Promise.all([
        loadCampaignEvidence(entry),
        loadCampaignTemplate(entry),
      ]);
      setVerified((current) => new Set(current).add(entry.stableId));
      onPlayEvidence({
        entry,
        evidence,
        cameraPresentation: parseCameraPresentation(template.extensions?.[CAMERA_EXTENSION_KEY]),
      });
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setBusy(null); }
  };

  return (
    <section style={styles.gallery} aria-label="Scenario Gallery" data-testid="campaign-drawer">
      <header style={styles.header}>
        <div>
          <div style={styles.eyebrow}>UniScenarios library</div>
          <h1 style={styles.title}>Scenario Gallery</h1>
          <div style={styles.subtitle}>Choose a verified replay to watch, or open an editable copy in the Studio.</div>
        </div>
        <button type="button" aria-label="Close Scenario Gallery" style={styles.close} onClick={onClose}>×</button>
      </header>

      <div style={styles.toolbar}>
        <label style={styles.searchWrap}>
          <span aria-hidden="true" style={styles.searchIcon}>⌕</span>
          <input
            ref={searchRef}
            type="search"
            className="studio-field"
            value={query}
            placeholder="Search scenarios, actors, or hazards…  /"
            aria-label="Search scenarios"
            style={styles.search}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <label style={styles.locationLabel}>
          <span>Location</span>
          <select value={mapFilter} aria-label="Filter by location" className="studio-field" style={styles.select} onChange={(event) => setMapFilter(event.target.value)}>
            <option value="all">All locations</option>
            {locations.map((id) => <option key={id} value={id}>{mapById(id)?.label ?? id}</option>)}
          </select>
        </label>
      </div>

      <div style={styles.filterRow} role="group" aria-label="Scenario filters">
        {FILTERS.map((item) => (
          <button
            key={item.id}
            type="button"
            className="studio-btn"
            aria-pressed={filter === item.id}
            style={{ ...styles.filter, ...(filter === item.id ? styles.filterActive : null) }}
            onClick={() => setFilter(item.id)}
          >{item.label}</button>
        ))}
        <span style={styles.resultCount} aria-live="polite">{visibleEntries.length} scenario{visibleEntries.length === 1 ? '' : 's'}</span>
      </div>

      {GENERATED_CAMPAIGN_DIAGNOSTICS.length ? (
        <div style={styles.diagnostics} data-testid="campaign-diagnostics">
          <strong>Some scenarios are unavailable</strong>
          {GENERATED_CAMPAIGN_DIAGNOSTICS.map((item) => <div key={item}>⚠ {item}</div>)}
        </div>
      ) : null}
      {error ? <div role="alert" style={styles.error} data-testid="campaign-error">{error}</div> : null}
      {detailsLoading ? <div style={styles.loading} aria-live="polite">Loading scenario details…</div> : null}

      <div style={styles.content}>
        {visibleEntries.length ? (
          <div style={styles.grid} data-testid="scenario-gallery-grid">
            {visibleEntries.map((entry) => {
              const ready = isCampaignReady(entry);
              const imported = importedByStableId.get(entry.stableId);
              const details = galleryDetails(entry);
              const runtime = runtimeDetails.get(entry.stableId);
              const ambientStatus = campaignAmbientStatus(entry.ambient);
              const location = entry.mapId ? mapById(entry.mapId)?.label ?? entry.mapId : 'Location unavailable';
              return (
                <article key={entry.stableId} className="studio-tile-hover" style={styles.card} data-testid={`campaign-scenario-${entry.ordinal}`}>
                  <div style={styles.cardHeading}>
                    <span style={styles.number}>{String(entry.ordinal).padStart(2, '0')}</span>
                    <div>
                      <h2 style={styles.cardTitle}>{entry.title.replace(/^\d+\s*[·.:~-]\s*/, '')}</h2>
                      <div style={styles.location}>{location}</div>
                    </div>
                  </div>
                  <p style={styles.summary}>{details.summary}</p>
                  <div style={styles.facts}>
                    <span>{runtime?.duration ?? 20}s</span>
                    <span>{runtime ? `${runtime.actors} actors` : 'actors loading…'}</span>
                    <span>{entry.binding === 'exact-matched-site' ? 'Exact site' : 'Behavioral site'}</span>
                  </div>
                  <div style={styles.tags} aria-label="Scenario tags">
                    {details.tags.map((tag) => <span key={tag} style={styles.tag}>{tag}</span>)}
                  </div>
                  <div style={styles.statuses}>
                    <Status label="Simulation" value={verified.has(entry.stableId) ? 'Runtime verified' : 'Verified evidence'} good={ready} />
                    <Status label="Ambient traffic" value={ambientStatus.value} good={ambientStatus.good} />
                    <Status label="Variations" value={variationLabel(entry)} good={hasVerifiedVariation(entry)} />
                  </div>
                  {entry.diagnostics.length ? <div style={styles.entryDiagnostics}>{entry.diagnostics.join(' · ')}</div> : null}
                  <div style={styles.actions}>
                    <button
                      type="button"
                      className="studio-btn"
                      data-testid={`campaign-play-evidence-${entry.ordinal}`}
                      disabled={!ready || busy !== null}
                      style={styles.play}
                      onClick={() => void playEvidence(entry)}
                    >{busy === entry.stableId ? 'Loading…' : '▶ Play verified 20s'}</button>
                    <div style={styles.editActions}>
                      <button
                        type="button"
                        className="studio-btn"
                        data-testid={`campaign-open-${entry.ordinal}`}
                        disabled={!authoringEnabled || !ready || busy !== null}
                        style={styles.edit}
                        onClick={() => void openEntry(entry)}
                      >Open editable copy</button>
                      {imported ? (
                        <button type="button" className="studio-btn" data-testid={`campaign-reopen-${entry.ordinal}`} disabled={busy !== null} style={styles.reopen} onClick={() => void reopen(entry, imported)}>Reopen saved</button>
                      ) : null}
                    </div>
                    <div style={styles.modeHint}>
                      <span style={styles.verifiedDot}>●</span> Replay is read-only and preserves the exact verified trace.
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div style={styles.empty} data-testid="scenario-gallery-empty">
            <strong>No scenarios match these filters.</strong>
            <span>Try another location, clear the search, or show all scenarios.</span>
            <button type="button" className="studio-btn" style={styles.clearFilters} onClick={() => { setQuery(''); setFilter('all'); setMapFilter('all'); }}>Clear filters</button>
          </div>
        )}
      </div>

      <footer style={styles.footer}>
        <div><strong>{GENERATED_CAMPAIGN_ENTRIES.length}/12</strong> curated scenarios · <strong>{imports.length}</strong> saved locally</div>
        <details>
          <summary style={styles.importSummary}>Library setup</summary>
          <div style={styles.importPopover}>
            <div>Save editable copies of the complete campaign in this browser.</div>
            <button
              type="button"
              className="studio-btn"
              data-testid="campaign-import-all"
              disabled={!authoringEnabled || !allReady || busy !== null}
              style={styles.importAll}
              onClick={() => {
                setBusy('all'); setError(null);
                void importAllCampaignEntries().then(() => setImports(campaignImports()), (reason: unknown) => {
                  setError(reason instanceof Error ? reason.message : String(reason));
                }).finally(() => setBusy(null));
              }}
            >{busy === 'all' ? 'Importing…' : 'Import all editable copies'}</button>
          </div>
        </details>
      </footer>
    </section>
  );
}

function variationLabel(entry: GeneratedCampaignEntry): string {
  if (hasVerifiedVariation(entry)) return entry.matchCount ? `${entry.matchCount} verified site${entry.matchCount === 1 ? '' : 's'}` : 'Verified';
  if (entry.transfer === 'zero-transferable-sites') return 'No compatible sites';
  return 'Not verified';
}

export function campaignAmbientStatus(value: string): { value: string; good: boolean } {
  if (value === 'sumo-smoke-verified') return { value: 'SUMO smoke verified', good: true };
  if (value === 'verified-evidence') return { value: 'Verified evidence', good: true };
  return { value: 'Not verified', good: false };
}

function Status({ label, value, good }: { label: string; value: string; good: boolean }): JSX.Element {
  return (
    <div style={styles.status} title={`${label}: ${value}`}>
      <span style={{ ...styles.statusDot, background: good ? 'var(--ueui-ok, #57c785)' : 'rgba(255, 255, 255, 0.28)' }} />
      <span><small>{label}</small><strong>{value}</strong></span>
    </div>
  );
}

const GLASS_SURFACE: CSSProperties = {
  background: 'linear-gradient(180deg, var(--ueui-glass-high, rgba(19, 24, 32, 0.92)), var(--ueui-glass-low, rgba(8, 11, 16, 0.94)))',
  backdropFilter: 'blur(72px) saturate(185%)',
  WebkitBackdropFilter: 'blur(72px) saturate(185%)',
};

const styles: Record<string, CSSProperties> = {
  gallery: { height: '100%', display: 'flex', flexDirection: 'column', boxSizing: 'border-box', border: '1px solid var(--ueui-line-strong, rgba(255,255,255,.14))', borderRadius: 'var(--ueui-radius, 10px)', ...GLASS_SURFACE, boxShadow: 'var(--ueui-shadow, 0 18px 48px rgba(0,0,0,.55))', overflow: 'hidden', color: 'var(--ueui-text, #f2f2f2)' },
  header: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 20, padding: '20px 22px 16px', borderBottom: '1px solid var(--ueui-line, rgba(255,255,255,.08))' },
  eyebrow: { color: 'var(--ueui-accent, #e8e044)', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1.2 },
  title: { margin: '3px 0 0', color: 'var(--ueui-text, #f2f2f2)', fontSize: 24, lineHeight: 1.2, fontWeight: 650 },
  subtitle: { marginTop: 4, color: 'var(--ueui-text-muted, #9a9a9a)', fontSize: 12 },
  close: { width: 34, height: 34, border: '1px solid var(--ueui-line, rgba(255,255,255,.08))', borderRadius: 8, background: 'rgba(255,255,255,.03)', color: 'var(--ueui-text-muted, #9a9a9a)', fontSize: 21, cursor: 'pointer' },
  toolbar: { display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'end', padding: '14px 18px 9px' },
  searchWrap: { position: 'relative', flex: '1 1 340px' },
  searchIcon: { position: 'absolute', left: 11, top: 8, color: 'var(--ueui-text-muted, #9a9a9a)', fontSize: 17 },
  search: { width: '100%', boxSizing: 'border-box', padding: '9px 12px 9px 34px' },
  locationLabel: { display: 'flex', flexDirection: 'column', gap: 3, color: 'var(--ueui-text-muted, #9a9a9a)', fontSize: 9, textTransform: 'uppercase', letterSpacing: .6 },
  select: { minWidth: 190, padding: '8px 10px', fontSize: 11, textTransform: 'none' },
  filterRow: { display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', padding: '0 18px 12px' },
  filter: { padding: '5px 11px', border: '1px solid var(--ueui-line, rgba(255,255,255,.08))', borderRadius: 999, background: 'rgba(255,255,255,.03)', color: 'var(--ueui-text-muted, #9a9a9a)', font: 'inherit', fontSize: 10, cursor: 'pointer' },
  filterActive: { borderColor: 'transparent', background: 'var(--ueui-accent, #e8e044)', color: '#10120a', fontWeight: 600 },
  resultCount: { marginLeft: 'auto', color: 'var(--ueui-text-muted, #9a9a9a)', fontSize: 10 },
  diagnostics: { margin: '0 18px 9px', padding: 9, borderRadius: 7, background: 'rgba(240,161,60,.12)', color: 'var(--ueui-warn, #f0a13c)', fontSize: 10 },
  error: { margin: '0 18px 9px', padding: 9, borderRadius: 7, background: 'rgba(255,107,94,.12)', color: 'var(--ueui-danger, #ff6b5e)', fontSize: 10, whiteSpace: 'pre-wrap' },
  loading: { padding: '0 18px 8px', color: 'var(--ueui-text-muted, #9a9a9a)', fontSize: 10 },
  content: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 18px 18px' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 310px), 1fr))', gap: 12 },
  card: { display: 'flex', flexDirection: 'column', minHeight: 370, padding: 14, borderRadius: 'var(--ueui-radius, 10px)', border: '1px solid var(--ueui-line, rgba(255,255,255,.08))', background: 'linear-gradient(180deg, rgba(255,255,255,.035), rgba(255,255,255,.012))' },
  cardHeading: { display: 'flex', gap: 10, alignItems: 'flex-start' },
  number: { flex: '0 0 auto', padding: '3px 6px', borderRadius: 5, background: 'var(--ueui-accent-soft, rgba(232,224,68,.16))', color: 'var(--ueui-accent, #e8e044)', fontWeight: 700, fontSize: 10 },
  cardTitle: { margin: 0, color: 'var(--ueui-text, #f2f2f2)', fontWeight: 600, fontSize: 14, lineHeight: 1.3 },
  location: { marginTop: 3, color: 'var(--ueui-text-muted, #9a9a9a)', fontSize: 10 },
  summary: { minHeight: 49, margin: '11px 0 9px', color: 'rgba(242,242,242,.78)', fontSize: 11, lineHeight: 1.5 },
  facts: { display: 'flex', flexWrap: 'wrap', gap: 5, color: 'var(--ueui-text-muted, #9a9a9a)', fontSize: 9.5 },
  tags: { display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 9 },
  tag: { padding: '2px 7px', borderRadius: 999, border: '1px solid var(--ueui-line, rgba(255,255,255,.08))', background: 'rgba(255,255,255,.03)', color: 'var(--ueui-text-muted, #9a9a9a)', fontSize: 8.5 },
  statuses: { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 5, marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--ueui-line, rgba(255,255,255,.08))' },
  status: { display: 'flex', gap: 5, minWidth: 0, alignItems: 'flex-start', color: 'rgba(242,242,242,.82)' },
  statusDot: { flex: '0 0 auto', width: 6, height: 6, borderRadius: 999, marginTop: 4 },
  entryDiagnostics: { marginTop: 8, color: 'var(--ueui-danger, #ff6b5e)', fontSize: 9.5 },
  actions: { marginTop: 'auto', paddingTop: 13 },
  play: { width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid transparent', background: 'var(--ueui-accent, #e8e044)', color: '#10120a', font: 'inherit', fontWeight: 700, cursor: 'pointer' },
  editActions: { display: 'flex', gap: 6, marginTop: 7 },
  edit: { flex: 1, padding: '6px 7px', borderRadius: 8, border: '1px solid var(--ueui-line-strong, rgba(255,255,255,.14))', background: 'rgba(255,255,255,.05)', color: 'var(--ueui-text, #f2f2f2)', font: 'inherit', fontSize: 10, cursor: 'pointer' },
  reopen: { padding: '6px 7px', borderRadius: 8, border: '1px solid var(--ueui-line-strong, rgba(255,255,255,.14))', background: 'rgba(255,255,255,.05)', color: 'var(--ueui-text, #f2f2f2)', font: 'inherit', fontSize: 10, cursor: 'pointer' },
  modeHint: { marginTop: 7, color: 'var(--ueui-text-muted, #9a9a9a)', fontSize: 8.5 },
  verifiedDot: { color: 'var(--ueui-ok, #57c785)', marginRight: 3 },
  empty: { minHeight: 240, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6, border: '1px dashed var(--ueui-line-strong, rgba(255,255,255,.14))', borderRadius: 'var(--ueui-radius, 10px)', color: 'var(--ueui-text-muted, #9a9a9a)' },
  clearFilters: { marginTop: 7, padding: '6px 10px', border: '1px solid var(--ueui-line-strong, rgba(255,255,255,.14))', borderRadius: 8, background: 'rgba(255,255,255,.05)', color: 'var(--ueui-text, #f2f2f2)', cursor: 'pointer' },
  footer: { position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '10px 18px', borderTop: '1px solid var(--ueui-line, rgba(255,255,255,.08))', color: 'var(--ueui-text-muted, #9a9a9a)', fontSize: 10 },
  importSummary: { cursor: 'pointer', color: 'var(--ueui-text, #f2f2f2)' },
  importPopover: { position: 'absolute', right: 14, bottom: 40, width: 230, padding: 10, border: '1px solid var(--ueui-line-strong, rgba(255,255,255,.14))', borderRadius: 'var(--ueui-radius, 10px)', ...GLASS_SURFACE, boxShadow: 'var(--ueui-shadow, 0 18px 48px rgba(0,0,0,.55))' },
  importAll: { width: '100%', marginTop: 8, padding: '7px 9px', borderRadius: 8, border: '1px solid transparent', background: 'var(--ueui-accent, #e8e044)', color: '#10120a', font: 'inherit', fontWeight: 650, cursor: 'pointer' },
};
