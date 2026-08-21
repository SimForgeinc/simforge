import type { CSSProperties } from 'react';
import type { PlaybackState } from '@uniscenarios/playback';
import type { PlaybackCameraOption } from '../playback/PlaybackPanel';

export interface VerifiedReplayPresentation {
  readonly current: number;
  readonly start: number;
  readonly end: number;
  readonly percent: number;
  readonly status: 'Playing' | 'Paused' | 'Complete';
}

export function verifiedReplayKeyboardAction(input: {
  readonly code: string;
  readonly key: string;
  readonly repeat: boolean;
  readonly modified: boolean;
  readonly editable: boolean;
}): 'toggle' | 'stop' | null {
  if (input.repeat || input.modified || input.editable) return null;
  if (input.code === 'Space') return 'toggle';
  if (input.key === 'Escape') return 'stop';
  return null;
}

export function verifiedReplayPresentation(
  state: Pick<PlaybackState, 'time' | 'startTime' | 'endTime' | 'playing'> | null,
  fallback: { readonly startTime: number; readonly endTime: number },
): VerifiedReplayPresentation {
  const start = state?.startTime ?? fallback.startTime;
  const end = state?.endTime ?? fallback.endTime;
  const current = Math.max(start, Math.min(end, state?.time ?? start));
  const duration = Math.max(0, end - start);
  const percent = duration === 0 ? 100 : ((current - start) / duration) * 100;
  return {
    current,
    start,
    end,
    percent,
    status: current >= end ? 'Complete' : state?.playing ? 'Playing' : 'Paused',
  };
}

export function VerifiedReplayBar({
  title,
  state,
  startTime,
  endTime,
  onToggle,
  onStop,
  cameraOptions,
  onCameraChange,
}: {
  title: string;
  state: PlaybackState | null;
  startTime: number;
  endTime: number;
  onToggle: () => void;
  onStop: () => void;
  cameraOptions: readonly PlaybackCameraOption[];
  onCameraChange: (option: PlaybackCameraOption) => void;
}): JSX.Element {
  const replay = verifiedReplayPresentation(state, { startTime, endTime });
  const complete = replay.status === 'Complete';
  const toggleLabel = complete ? 'Replay verified scenario' : replay.status === 'Playing' ? 'Pause verified replay' : 'Resume verified replay';

  return (
    <section style={styles.bar} aria-label={`Verified replay: ${title}`} data-testid="campaign-replay-bar">
      <div style={styles.identity}>
        <span style={styles.eyebrow}>Verified read-only replay</span>
        <strong style={styles.title}>{title}</strong>
      </div>
      <div style={styles.transport}>
        <div style={styles.readoutRow}>
          <span
            style={{ ...styles.status, ...(complete ? styles.complete : null) }}
            role="status"
            aria-live="polite"
            data-testid="verified-replay-state"
          >{replay.status}</span>
          <output style={styles.time} aria-label="Verified replay time" data-testid="verified-replay-time">
            {replay.current.toFixed(2)} / {replay.end.toFixed(2)} s
          </output>
        </div>
        <div
          role="progressbar"
          aria-label="Verified replay progress"
          aria-valuemin={replay.start}
          aria-valuemax={replay.end}
          aria-valuenow={replay.current}
          aria-valuetext={`${replay.current.toFixed(2)} of ${replay.end.toFixed(2)} seconds, ${replay.status.toLowerCase()}`}
          style={styles.progressTrack}
          data-testid="verified-replay-progress"
        >
          <span style={{ ...styles.progressFill, width: `${replay.percent}%` }} />
        </div>
      </div>
      <div style={styles.actions}>
        <label style={styles.cameraLabel}>
          <span>Camera</span>
          <select
            aria-label="Playback camera"
            className="studio-field"
            value={state?.cameraSelectionId ?? 'all-actors'}
            disabled={!state}
            onChange={(event) => {
              const option = cameraOptions.find((item) => item.id === event.target.value);
              if (option) onCameraChange(option);
            }}
          >
            {cameraOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select>
          {state?.cameraReason ? <small style={styles.cameraReason}>{state.cameraReason}</small> : null}
        </label>
        <span style={styles.keyboardHint} aria-hidden="true">Space pause/resume · Esc stop</span>
        <button
          type="button"
          style={styles.toggle}
          aria-label={toggleLabel}
          className="studio-btn"
          onClick={onToggle}
          disabled={!state}
          data-testid="verified-replay-toggle"
        >{complete ? '↻ Replay' : replay.status === 'Playing' ? 'Ⅱ Pause' : '▶ Resume'}</button>
        <button type="button" className="studio-btn" style={styles.stop} onClick={onStop} data-testid="verified-replay-stop">
          ■ Stop &amp; return to Gallery
        </button>
      </div>
    </section>
  );
}

const styles: Record<string, CSSProperties> = {
  bar: {
    position: 'absolute', zIndex: 22, top: 12, left: 64, right: 16,
    display: 'grid', gridTemplateColumns: 'minmax(180px, 1fr) minmax(240px, 2fr) auto',
    alignItems: 'center', gap: 16, padding: '9px 12px',
    border: '1px solid var(--ueui-line-strong, rgba(255,255,255,.14))',
    borderRadius: 'var(--ueui-radius, 10px)',
    background: 'linear-gradient(180deg, var(--ueui-glass-high, rgba(19, 24, 32, 0.92)), var(--ueui-glass-low, rgba(8, 11, 16, 0.94)))',
    backdropFilter: 'blur(72px) saturate(185%)',
    WebkitBackdropFilter: 'blur(72px) saturate(185%)',
    boxShadow: 'var(--ueui-shadow, 0 18px 48px rgba(0,0,0,.55))',
    color: 'var(--ueui-text, #f2f2f2)',
  },
  identity: { minWidth: 0 },
  eyebrow: { display: 'block', color: 'var(--ueui-ok, #57c785)', fontSize: 8, fontWeight: 650, textTransform: 'uppercase', letterSpacing: .8 },
  title: { display: 'block', overflow: 'hidden', color: 'var(--ueui-text, #f2f2f2)', fontSize: 11, textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  transport: { minWidth: 0 },
  readoutRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 4 },
  status: { color: 'var(--ueui-warn, #f0a13c)', fontSize: 9, fontWeight: 650, textTransform: 'uppercase', letterSpacing: .6 },
  complete: { color: 'var(--ueui-ok, #57c785)' },
  time: { color: 'var(--ueui-text, #f2f2f2)', fontSize: 11, fontVariantNumeric: 'tabular-nums' },
  progressTrack: { display: 'block', height: 5, overflow: 'hidden', borderRadius: 999, background: 'rgba(255,255,255,.1)' },
  progressFill: { display: 'block', height: '100%', borderRadius: 999, background: 'var(--ueui-accent, #e8e044)', transition: 'width 80ms linear' },
  actions: { display: 'flex', alignItems: 'center', gap: 7 },
  cameraLabel: { display: 'flex', alignItems: 'center', gap: 5, color: 'var(--ueui-text-muted, #9a9a9a)', fontSize: 8, whiteSpace: 'nowrap' },
  cameraReason: { maxWidth: 180, overflow: 'hidden', color: 'var(--ueui-text-muted, #9a9a9a)', fontSize: 8, textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  keyboardHint: { color: 'var(--ueui-text-muted, #9a9a9a)', fontSize: 8, whiteSpace: 'nowrap' },
  toggle: { padding: '7px 10px', border: '1px solid var(--ueui-line-strong, rgba(255,255,255,.14))', borderRadius: 7, background: 'rgba(255,255,255,.05)', color: 'var(--ueui-text, #f2f2f2)', font: 'inherit', fontSize: 10, cursor: 'pointer' },
  stop: { padding: '7px 10px', border: '1px solid transparent', borderRadius: 7, background: 'var(--ueui-accent, #e8e044)', color: '#10120a', font: 'inherit', fontSize: 10, fontWeight: 650, cursor: 'pointer' },
};
