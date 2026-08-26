"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react';
import type { AmbientTrafficProvenance, ResolvedAmbientTrafficProfile } from '@simforge-oss/engine';
import { ambientPromotionCapability, nextAmbientSeed, profileForPreset, type AmbientTrafficPreset } from '@simforge-oss/playback/traffic';
import type { AmbientRobustnessSummary } from '../playback/scenario-worker';
import type { AmbientTrafficProviderId, SumoTrafficStatus } from '@simforge-oss/playback/traffic';

export interface AmbientTrafficPanelProps {
  profile: ResolvedAmbientTrafficProfile;
  provenance: AmbientTrafficProvenance | null;
  busy?: boolean;
  error?: string | null;
  onChange: (profile: ResolvedAmbientTrafficProfile) => void;
  provider?: AmbientTrafficProviderId;
  onProviderChange?: (provider: AmbientTrafficProviderId) => void;
  acceleratedSignalCycles?: boolean;
  onAcceleratedSignalCyclesChange?: (enabled: boolean) => void;
  allSignalsGreen?: boolean;
  onAllSignalsGreenChange?: (enabled: boolean) => void;
  sumoStatus?: SumoTrafficStatus | null;
  sumoAvailable?: boolean;
  sumoUnavailableReason?: string | null;
  robustnessReport?: AmbientRobustnessSummary | null;
  robustnessBusy?: boolean;
  onRunRobustness?: () => void;
  defaultOpen?: boolean;
  alwaysOpen?: boolean;
}

const PRESETS: readonly { id: AmbientTrafficPreset; label: string }[] = [
  { id: 'off', label: 'Off' },
  { id: 'light', label: 'Light' },
  { id: 'moderate', label: 'Moderate' },
  { id: 'city', label: 'City' },
  { id: 'heavy', label: 'Heavy' },
  { id: 'custom', label: 'Custom' },
];

/** Scenario-owned background traffic controls. Generated actors stay separate from authored actors. */
export function AmbientTrafficPanel({ profile, provenance, busy = false, error = null, onChange, provider = 'off', onProviderChange, acceleratedSignalCycles = false, onAcceleratedSignalCyclesChange, allSignalsGreen = false, onAllSignalsGreenChange, sumoStatus = null, sumoAvailable = true, sumoUnavailableReason = null, robustnessReport = null, robustnessBusy = false, onRunRobustness, defaultOpen = false, alwaysOpen = false }: AmbientTrafficPanelProps): ReactElement {
  const [open, setOpen] = useState(defaultOpen);
  const [seedDraft, setSeedDraft] = useState(String(profile.seed));
  const [promotionActorId, setPromotionActorId] = useState('');

  useEffect(() => setSeedDraft(String(profile.seed)), [profile.seed]);
  useEffect(() => {
    if (!provenance?.actors.some((actor) => actor.id === promotionActorId)) setPromotionActorId(provenance?.actors[0]?.id ?? '');
  }, [promotionActorId, provenance]);
  const promotionActor = provenance?.actors.find((actor) => actor.id === promotionActorId);
  const promotion = promotionActor ? ambientPromotionCapability(promotionActor.routeLaneRsls) : null;
  const engineOff = provider === 'off';

  const updateCustom = (patch: Partial<ResolvedAmbientTrafficProfile>): void => {
    onChange({ ...profile, ...patch, preset: 'custom' });
  };
  const commitSeed = (): void => {
    const seed = seedDraft.trim();
    if (seed && seed !== String(profile.seed)) onChange({ ...profile, seed });
    else setSeedDraft(String(profile.seed));
  };

  return (
    <section style={styles.root} data-testid="ambient-traffic-panel">
      {!alwaysOpen ? <button
        type="button"
        style={styles.disclosure}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        data-testid="ambient-traffic-disclosure"
      >
        <span>Ambient traffic</span>
        <span style={profile.preset === 'off' ? styles.muted : styles.active}>
          {busy ? 'generating…' : profile.preset} {open ? '⌃' : '⌄'}
        </span>
      </button> : null}
      {alwaysOpen || open ? <div style={alwaysOpen ? styles.popoverBody : styles.body}>
        <label style={styles.label}>
          Traffic engine
          <select
            value={provider}
            onChange={(event) => onProviderChange?.(event.target.value as AmbientTrafficProviderId)}
            style={styles.select}
            data-testid="ambient-traffic-provider"
          >
            <option value="off">Off</option>
            <option value="native">Native</option>
            <option value="sumo" disabled={!sumoAvailable}>SUMO (Experimental)</option>
          </select>
        </label>
        {!sumoAvailable ? <div style={styles.error} role="status" data-testid="sumo-unavailable">
          {sumoUnavailableReason ?? 'This map does not include an immutable SUMO road network.'}
        </div> : null}
        {engineOff ? <div style={styles.status} role="status" aria-live="polite" data-testid="ambient-traffic-off-status">
          <strong>Ambient traffic off</strong>
          <div>No background vehicles or traffic engine are running.</div>
        </div> : null}
        {provider === 'sumo' && sumoStatus ? <div style={sumoStatus.phase === 'fallback' ? styles.error : styles.status} data-testid="sumo-traffic-status">
          <strong>{sumoStatus.phase === 'fallback' ? 'SUMO unavailable' : `SUMO ${sumoStatus.phase}`}</strong>
          {sumoStatus.reason ? ` · ${sumoStatus.reason}` : null}
          {sumoStatus.phase !== 'fallback' ? <>
            <div>{sumoStatus.actorCount}/{sumoStatus.requestedActorCount ?? sumoStatus.actorCount} active · {sumoStatus.nearbyRouteStarts ?? 0} local route starts · {formatBytes(sumoStatus.heapBytes)} heap</div>
            {(sumoStatus.simulatedActorCount ?? sumoStatus.actorCount) > sumoStatus.actorCount ? <div>{sumoStatus.simulatedActorCount} simulated · presentation capped at {sumoStatus.actorCount}</div> : null}
            <div>{sumoStatus.nearbyActorCount ?? 0} nearby · {sumoStatus.queuedActorCount ?? 0} queued · {sumoStatus.completedActorCount ?? 0} completed</div>
            <div>{sumoStatus.emergencyStoppingActorCount ?? 0} emergency braking · safety counters {sumoStatus.detailedSafetyMetricsAvailable ? 'available' : 'not exposed'}</div>
            <div>{formatMs(sumoStatus.initMilliseconds)} init · {formatMs(sumoStatus.stepP95Milliseconds)} step p95</div>
          </> : null}
        </div> : null}
        {provider === 'sumo' ? <div style={styles.toggleBlock}>
          <label style={styles.toggleLabel}>
            <input
              type="checkbox"
              checked={allSignalsGreen}
              onChange={(event) => onAllSignalsGreenChange?.(event.currentTarget.checked)}
              disabled={busy}
              data-testid="ambient-traffic-all-signals-green"
            />
            <span>Set all traffic lights green</span>
          </label>
          <div style={styles.toggleHint}>
            Overrides every SUMO-controlled light during preview. This can create conflicting traffic movements.
          </div>
          <label style={styles.toggleLabel}>
            <input
              type="checkbox"
              checked={acceleratedSignalCycles}
              onChange={(event) => onAcceleratedSignalCyclesChange?.(event.currentTarget.checked)}
              disabled={busy}
              data-testid="ambient-traffic-accelerated-signal-cycles"
            />
            <span>Accelerated signal cycles</span>
          </label>
          <div style={styles.toggleHint}>
            Compress long map signal programs to fit the scenario preview. Off uses the map's original timings.
          </div>
        </div> : null}
        <label style={styles.label}>
          Density preset
          <select
            value={profile.preset}
            onChange={(event) => onChange(profileForPreset(event.target.value as AmbientTrafficPreset, profile))}
            style={styles.select}
            data-testid="ambient-traffic-preset"
            disabled={busy || engineOff}
          >
            {PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
          </select>
        </label>
        <div style={styles.hint}>Saved with this scenario and previewed on the map. Generated vehicles stay out of actor timelines.</div>
        {profile.preset === 'heavy' || profile.maxActors > 80 ? <div style={styles.performanceNote}>
          Separated traffic uses the spatial broadphase. Dense co-located clusters and trace metrics can still become slower as actor count rises.
        </div> : null}

        <label style={styles.label}>
          Seed
          <span style={styles.seedRow}>
            <input
              value={seedDraft}
              onChange={(event) => setSeedDraft(event.target.value)}
              onBlur={commitSeed}
              onKeyDown={(event) => {
                if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
              }}
              style={styles.input}
              data-testid="ambient-traffic-seed"
              disabled={busy || engineOff}
            />
            <button
              type="button"
              style={styles.regenerate}
              onClick={() => onChange({ ...profile, seed: nextAmbientSeed(profile.seed) })}
              data-testid="ambient-traffic-regenerate"
              title="Generate another deterministic traffic population"
              disabled={busy || engineOff}
            >↻</button>
          </span>
        </label>

        {profile.preset === 'custom' ? <div data-testid="ambient-traffic-custom-controls">
          <Range
            label="Vehicles / lane km"
            value={profile.densityVehiclesPerKm}
            min={0} max={80} step={1}
            testId="ambient-traffic-density"
            disabled={busy || engineOff}
            onChange={(densityVehiclesPerKm) => updateCustom({ densityVehiclesPerKm })}
          />
          <Range
            label="Max actors"
            value={profile.maxActors}
            min={0} max={128} step={1}
            testId="ambient-traffic-max-actors"
            disabled={busy || engineOff}
            onChange={(maxActors) => updateCustom({ maxActors })}
          />
          <Range
            label="Aggression"
            value={profile.aggressiveness}
            min={0} max={1} step={0.05}
            display={`${Math.round(profile.aggressiveness * 100)}%`}
            testId="ambient-traffic-aggression"
            disabled={busy || engineOff}
            onChange={(aggressiveness) => updateCustom({ aggressiveness })}
          />
          <Range
            label="Speed variance"
            value={profile.speedVariance}
            min={0} max={0.8} step={0.05}
            display={`±${Math.round(profile.speedVariance * 100)}%`}
            testId="ambient-traffic-speed-variance"
            disabled={busy || engineOff}
            onChange={(speedVariance) => updateCustom({ speedVariance })}
          />
          <Range
            label="Cyclists"
            value={profile.cyclistShare}
            min={0} max={Math.max(0, 1 - profile.pedestrianShare)} step={0.01}
            display={`${Math.round(profile.cyclistShare * 100)}%`}
            testId="ambient-traffic-cyclist-share"
            disabled={busy || engineOff}
            onChange={(cyclistShare) => updateCustom({ cyclistShare })}
          />
          <Range
            label="Pedestrians"
            value={profile.pedestrianShare}
            min={0} max={Math.max(0, 1 - profile.cyclistShare)} step={0.01}
            display={`${Math.round(profile.pedestrianShare * 100)}%`}
            testId="ambient-traffic-pedestrian-share"
            disabled={busy || engineOff}
            onChange={(pedestrianShare) => updateCustom({ pedestrianShare })}
          />
        </div> : null}

        {error ? <div style={styles.error} role="alert" data-testid="ambient-traffic-error">{error}</div> : null}
        {provenance ? <div style={styles.status} data-testid="ambient-traffic-provenance">
          <div data-testid="ambient-traffic-preview-count"><strong>{provenance.actors.length} visible</strong> · {provenance.eligibleLaneKm.toFixed(1)} lane km</div>
          <div data-testid="ambient-traffic-safety-summary">
            {provenance.screening.evaluated
              ? `Safety screen ${provenance.screening.count} removed over ${provenance.screening.passes} pass${provenance.screening.passes === 1 ? '' : 'es'}`
              : 'Live selection · full-clip checks run only in the robustness test'}
          </div>
          <div>profile {provenance.profileHash.slice(0, 10)} · seed {String(provenance.profile.seed)}</div>
          {provenance.warnings.map((warning) => <div key={warning} style={styles.warning}>{warning}</div>)}
        </div> : null}
        {onRunRobustness ? <button
          type="button"
          style={styles.action}
          disabled={busy || robustnessBusy}
          onClick={onRunRobustness}
          data-testid="ambient-traffic-run-robustness"
        >{robustnessBusy ? 'Testing Off / Light / Moderate…' : 'Test scenario with background traffic'}</button> : null}
        {robustnessReport ? <div style={styles.report} data-testid="ambient-traffic-robustness-report">
          <div style={robustnessReport.overall === 'accepted' ? styles.pass : robustnessReport.overall === 'incomplete' ? styles.incomplete : styles.fail}>
            {robustnessReport.overall === 'accepted'
              ? '✓ Robust and authored intent preserved'
              : robustnessReport.overall === 'incomplete'
                ? 'Incomplete — authored intent not evaluated'
                : 'Rejected — robustness or authored intent failed'}
          </div>
          <div>Generic baseline {robustnessReport.baselineVerdict} · intent {robustnessReport.intent.status === 'evaluated' ? robustnessReport.intent.baselineVerdict : 'not evaluated'}</div>
          <div>{Object.keys(robustnessReport.filters).length} generic evaluation filter fields preserved; these do not prove authored intent.</div>
          {robustnessReport.cases.map((item) => <div key={item.label} style={styles.caseRow} data-testid={`ambient-robustness-case-${item.label}`}>
            <strong>{item.label}</strong>
            <span>{item.generatedActors} actors · {item.runtimeMs.toFixed(0)} ms · {item.ambientCollisions} collisions</span>
            <span>{item.deterministic ? 'deterministic' : 'non-deterministic'} · {item.authoredEventOrderPreserved ? 'order kept' : 'order changed'} · {item.verdict}</span>
            {item.failures.map((failure) => <span key={failure} style={styles.fail}>{failure}</span>)}
          </div>)}
        </div> : null}
        {provenance && provenance.actors.length > 0 ? <div style={styles.promotion} data-testid="ambient-traffic-promotion">
          <div style={styles.promotionTitle}>Adopt generated actor</div>
          <select value={promotionActorId} onChange={(event) => setPromotionActorId(event.target.value)} style={styles.select} data-testid="ambient-traffic-promote-select">
            {provenance.actors.map((actor) => <option key={actor.id} value={actor.id}>{actor.kind} · {actor.id.slice(-8)}</option>)}
          </select>
          <button type="button" disabled={!promotion?.safe} style={styles.action} data-testid="ambient-traffic-promote">Promote to authored actor</button>
          {!promotion?.safe ? <div style={styles.hint} data-testid="ambient-traffic-promote-reason">{promotion?.reason ?? 'Select a generated actor to inspect promotion support.'}</div> : null}
        </div> : null}
        <button
          type="button"
          style={styles.action}
          disabled={busy || engineOff}
          onClick={() => onChange(defaultAmbientProfileForReset(profile))}
          data-testid="ambient-traffic-reset"
        >Reset to City</button>
      </div> : null}
    </section>
  );
}

function formatMs(value: number | undefined): string {
  return value === undefined ? '—' : `${value.toFixed(1)} ms`;
}

function formatBytes(value: number | undefined): string {
  return value === undefined ? '—' : `${(value / 1024 / 1024).toFixed(0)} MiB`;
}

export interface AmbientTrafficPopoverProps extends Omit<AmbientTrafficPanelProps, 'defaultOpen' | 'alwaysOpen'> {
  onClose: () => void;
}

/** Compact map-toolbar surface; dismissal never captures or cancels map interaction. */
export function AmbientTrafficPopover({ onClose, ...panelProps }: AmbientTrafficPopoverProps): ReactElement {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    rootRef.current?.focus();
    const dismiss = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node) || rootRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest('[data-testid="tool-ambient"]')) return;
      onClose();
    };
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onClose();
      (document.querySelector('[data-testid="tool-ambient"]') as HTMLElement | null)?.focus();
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', escape, true);
    };
  }, [onClose]);

  return <div
    id="ambient-traffic-popover"
    ref={rootRef}
    role="dialog"
    aria-label="Ambient traffic configuration"
    tabIndex={-1}
    style={styles.popover}
    data-testid="ambient-traffic-popover"
  >
    <div style={styles.popoverHeader}>
      <div>
        <div style={styles.popoverEyebrow}>World</div>
        <div style={styles.popoverTitle}>Ambient traffic</div>
      </div>
      <button type="button" aria-label="Close ambient traffic" onClick={onClose} style={styles.close}>×</button>
    </div>
    <div style={styles.popoverCopy}>Deterministic background road users, kept separate from authored actors.</div>
    <AmbientTrafficPanel {...panelProps} alwaysOpen />
  </div>;
}

function defaultAmbientProfileForReset(profile: ResolvedAmbientTrafficProfile): ResolvedAmbientTrafficProfile {
  return profileForPreset('city', { ...profile, seed: 'ambient-1' });
}

function Range({ label, value, min, max, step, display, testId, disabled, onChange }: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display?: string;
  testId: string;
  disabled?: boolean;
  onChange: (value: number) => void;
}): ReactElement {
  return <label style={styles.range}>
    <span>{label}<b>{display ?? value.toFixed(step < 1 ? 2 : 0)}</b></span>
    <input type="range" value={value} min={min} max={max} step={step} disabled={disabled} onChange={(event) => onChange(Number(event.target.value))} data-testid={testId} />
  </label>;
}

const styles: Record<string, CSSProperties> = {
  root: { marginTop: 10, borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 8 },
  disclosure: { width: '100%', display: 'flex', justifyContent: 'space-between', border: 0, padding: '3px 0', background: 'transparent', color: '#d9dee8', font: 'inherit', cursor: 'pointer', textTransform: 'capitalize' },
  body: { paddingTop: 8 },
  popoverBody: { paddingTop: 0 },
  label: { display: 'grid', gap: 4, marginBottom: 8, color: '#8f98a6', fontSize: 11 },
  select: { width: '100%', padding: 6, borderRadius: 6, border: '1px solid rgba(255,255,255,0.13)', background: '#171b22', color: '#edf1f7', font: 'inherit' },
  input: { minWidth: 0, flex: 1, padding: 6, borderRadius: 6, border: '1px solid rgba(255,255,255,0.13)', background: '#171b22', color: '#edf1f7', font: 'inherit' },
  seedRow: { display: 'flex', gap: 5 },
  regenerate: { width: 31, borderRadius: 6, border: '1px solid rgba(255,255,255,0.13)', background: 'rgba(255,255,255,0.06)', color: '#edf1f7', cursor: 'pointer' },
  hint: { margin: '-2px 0 10px', color: '#707a89', fontSize: 10, lineHeight: 1.35 },
  toggleBlock: { margin: '1px 0 10px' },
  toggleLabel: { display: 'flex', alignItems: 'center', gap: 7, color: '#c8d0dc', fontSize: 11, cursor: 'pointer' },
  toggleHint: { margin: '4px 0 0 22px', color: '#707a89', fontSize: 10, lineHeight: 1.35 },
  range: { display: 'grid', gap: 1, margin: '7px 0', color: '#9da6b5', fontSize: 11 },
  active: { color: '#7fcf9b' },
  muted: { color: '#707a89' },
  status: { marginTop: 8, padding: 7, borderRadius: 6, background: 'rgba(0,0,0,.22)', color: '#aeb7c4', fontSize: 10, fontVariantNumeric: 'tabular-nums' },
  warning: { marginTop: 3, color: '#ffbd70' },
  performanceNote: { margin: '-3px 0 9px', color: '#d5a45e', fontSize: 10, lineHeight: 1.35 },
  error: { marginTop: 8, color: '#ff8d8d', fontSize: 10 },
  action: { width: '100%', marginTop: 8, padding: '6px 8px', borderRadius: 6, border: '1px solid rgba(255,255,255,.13)', background: 'rgba(255,255,255,.05)', color: '#edf1f7', font: 'inherit', fontSize: 10, cursor: 'pointer' },
  report: { marginTop: 8, padding: 7, borderRadius: 6, background: 'rgba(0,0,0,.28)', color: '#aeb7c4', fontSize: 10 },
  caseRow: { display: 'grid', gap: 1, padding: '5px 0', borderTop: '1px solid rgba(255,255,255,.06)' },
  pass: { color: '#7fcf9b' },
  fail: { color: '#ff9b9b' },
  incomplete: { color: '#f0be66' },
  promotion: { marginTop: 9, paddingTop: 8, borderTop: '1px solid rgba(255,255,255,.07)' },
  promotionTitle: { marginBottom: 5, color: '#cdd4df', fontSize: 10, fontWeight: 650 },
  popover: { position: 'absolute', zIndex: 24, top: 177, left: 63, bottom: 12, width: 'min(340px, calc(100% - 75px))', boxSizing: 'border-box', overflowY: 'auto', padding: 13, borderRadius: 9, outline: 'none', background: 'rgba(20,23,29,.98)', border: '1px solid #46505d', boxShadow: '0 18px 48px rgba(0,0,0,.52)', color: '#edf1f7', userSelect: 'none' },
  popoverHeader: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 },
  popoverEyebrow: { color: '#f07f2f', fontSize: 9, fontWeight: 750, letterSpacing: .8, textTransform: 'uppercase' },
  popoverTitle: { color: '#eef2f7', fontSize: 16, fontWeight: 680 },
  popoverCopy: { marginTop: 3, color: '#8f98a6', fontSize: 10, lineHeight: 1.35 },
  close: { width: 27, height: 27, padding: 0, border: 0, borderRadius: 5, background: 'transparent', color: '#9da6b4', fontSize: 21, cursor: 'pointer' },
};
