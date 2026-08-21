import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { ScenarioTemplateV2 } from '@uniscenarios/scenario-model';
import { buildCopilotMapContext } from './mapContext';
import { generateScenarioCandidates, updateLiveCopilotValidation } from './client';
import type { CopilotCandidate, CopilotGenerationResult, CopilotIntent, CopilotProgress, CopilotProviderId } from './types';
import type { EditorController } from '../editor/controller';
import type { MapEntry } from '../maps';
import type { GroundHeightSampler } from './grounding';

export interface CandidateValidation {
  readonly valid: boolean;
  readonly message: string;
  readonly actorCount: number;
  readonly durationS: number;
}

export interface ScenarioCopilotPanelProps {
  readonly controller: EditorController;
  readonly map: MapEntry;
  readonly sampleHeight: GroundHeightSampler | null;
  readonly onValidate: (candidate: CopilotCandidate) => Promise<CandidateValidation>;
  readonly onApply: (candidate: CopilotCandidate) => void;
  readonly onOpenGenerations: () => void;
  readonly onClose: () => void;
}

const STARTER = 'A sedan approaches a pedestrian who emerges from behind a stopped van. The pedestrian starts after four seconds and the sedan should brake to avoid a collision.';

export function ScenarioCopilotPanel({ controller, map, sampleHeight, onValidate, onApply, onOpenGenerations, onClose }: ScenarioCopilotPanelProps): JSX.Element {
  const [provider, setProvider] = useState<CopilotProviderId>('staged-rag');
  const [prompt, setPrompt] = useState(STARTER);
  const [progress, setProgress] = useState<CopilotProgress | null>(null);
  const [result, setResult] = useState<CopilotGenerationResult | null>(null);
  const [intentDraft, setIntentDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [validations, setValidations] = useState<Record<string, CandidateValidation | 'running'>>({});
  const abortRef = useRef<AbortController | null>(null);
  const mapContext = useMemo(
    () => buildCopilotMapContext(map, controller.laneIndex, sampleHeight),
    [controller, map, sampleHeight],
  );

  useEffect(() => () => abortRef.current?.abort(), []);

  const generate = async (confirmedIntent?: CopilotIntent, override?: { provider: CopilotProviderId; prompt: string }): Promise<void> => {
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;
    setBusy(true); setError(null); setResult(null); setValidations({});
    try {
      const chosenProvider = override?.provider ?? provider;
      const chosenPrompt = override?.prompt ?? prompt;
      const generated = await generateScenarioCandidates({
        providerId: chosenProvider,
        prompt: chosenPrompt,
        mapContext,
        currentScenario: controller.doc.data,
        maxCandidates: 2,
        ...(confirmedIntent ? { confirmedIntent } : {}),
      }, { signal: abort.signal, onProgress: setProgress });
      setResult(generated);
      setIntentDraft(JSON.stringify(generated.intent, null, 2));
      setBusy(false);
      for (const candidate of generated.candidates) {
        setValidations((current) => ({ ...current, [candidate.id]: 'running' }));
        const validation = await onValidate(candidate).catch((reason: unknown) => ({ valid: false, message: reason instanceof Error ? reason.message : String(reason), actorCount: 0, durationS: 0 }));
        setValidations((current) => ({ ...current, [candidate.id]: validation }));
        void updateLiveCopilotValidation(generated.runId, candidate.id, validation);
      }
    } catch (reason) {
      if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason));
      setBusy(false);
    }
  };

  const regenerateIntent = (): void => {
    try {
      const parsed = JSON.parse(intentDraft) as CopilotIntent;
      void generate(parsed);
    } catch {
      setError('The edited intent must be valid JSON. Actor and restriction fields remain schema-checked on the server.');
    }
  };

  return <section style={styles.panel} aria-label="Scenario Copilot" data-testid="scenario-copilot-panel">
    <header style={styles.header}>
      <div><div style={styles.eyebrow}>CURRENT-MAP GENERATION</div><h2 style={styles.heading}>Scenario Copilot</h2></div>
      <button type="button" style={styles.close} onClick={onClose} aria-label="Close Scenario Copilot">×</button>
    </header>
    <div style={styles.mapLock}><span>◉</span><div><strong>{map.label}</strong><small>{mapContext.laneCount} driving lanes · {mapContext.placementSlots.length} bounded placement slots</small></div><span style={styles.lock}>Locked</span></div>
    <nav style={styles.tabs} aria-label="Scenario Copilot views">
      <button type="button" data-testid="copilot-generate-tab" aria-current="page" style={{ ...styles.tab, ...styles.tabActive }}>Create</button>
      <button type="button" data-testid="copilot-comparison-tab" style={styles.tab} onClick={onOpenGenerations}>Open Generations ↗</button>
    </nav>
    <label style={styles.label}>Generation approach</label>
    <div style={styles.providers}>
      <button type="button" aria-pressed={provider === 'staged-rag'} style={{ ...styles.provider, ...(provider === 'staged-rag' ? styles.providerActive : {}) }} onClick={() => setProvider('staged-rag')}>
        <strong>Structured + retrieval</strong><small>Chat2Scenic-inspired staged pipeline</small>
      </button>
      <button type="button" aria-pressed={provider === 'direct-llm'} style={{ ...styles.provider, ...(provider === 'direct-llm' ? styles.providerActive : {}) }} onClick={() => setProvider('direct-llm')}>
        <strong>Direct native draft</strong><small>One model call into our typed format</small>
      </button>
      <button type="button" aria-pressed={provider === 'upstream-chat2scenic'} style={{ ...styles.provider, ...(provider === 'upstream-chat2scenic' ? styles.providerActive : {}) }} onClick={() => setProvider('upstream-chat2scenic')}>
        <strong>Upstream Chat2Scenic</strong><small>Research · CC BY-NC · Scenic compile/sample</small>
      </button>
      <button type="button" aria-pressed={provider === 'simulation-agent'} style={{ ...styles.provider, ...(provider === 'simulation-agent' ? styles.providerActive : {}) }} onClick={() => setProvider('simulation-agent')}>
        <strong>Simulation agent</strong><small>High effort · up to 4 simulate-and-repair loops</small>
      </button>
      <button type="button" aria-pressed={provider === 'simulation-agent-vision'} style={{ ...styles.provider, ...(provider === 'simulation-agent-vision' ? styles.providerActive : {}) }} onClick={() => setProvider('simulation-agent-vision')}>
        <strong>Simulation agent + 2D</strong><small>Same loop with deterministic bird's-eye grounding</small>
      </button>
      <button type="button" aria-pressed={provider === 'verified-template-search'} style={{ ...styles.provider, ...(provider === 'verified-template-search' ? styles.providerActive : {}) }} onClick={() => setProvider('verified-template-search')}>
        <strong>Verified template search</strong><small>Rank proven native patterns, then tune deterministically</small>
      </button>
      <button type="button" aria-pressed={provider === 'relative-goal-optimizer'} style={{ ...styles.provider, ...(provider === 'relative-goal-optimizer' ? styles.providerActive : {}) }} onClick={() => setProvider('relative-goal-optimizer')}>
        <strong>Relative goal optimizer</strong><small>1 intent call · bounded native parameter search</small>
      </button>
    </div>
    <label style={styles.label} htmlFor="copilot-prompt">Describe the scenario</label>
    <textarea id="copilot-prompt" data-testid="scenario-copilot-prompt" className="studio-field" style={styles.prompt} value={prompt} onChange={(event) => setPrompt(event.currentTarget.value)} disabled={busy} />
    <button type="button" data-testid="scenario-copilot-generate" className="studio-btn" style={styles.generate} disabled={busy || prompt.trim().length < 8} onClick={() => void generate()}>{busy ? 'Generating…' : 'Generate on this map'}</button>
    {progress ? <div role="status" style={styles.progress}><span>{progress.message}</span><span>{progress.completed}/{progress.total}</span></div> : null}
    {error ? <div role="alert" style={styles.error}>{error}</div> : null}
    {result ? <>
      <div style={styles.runMeta}><strong>{result.provider === 'staged-rag' ? 'Structured + retrieval' : result.provider === 'direct-llm' ? 'Direct native draft' : result.provider === 'simulation-agent' ? 'Simulation agent · no image' : result.provider === 'simulation-agent-vision' ? 'Simulation agent + 2D' : result.provider === 'verified-template-search' ? 'Verified template search' : result.provider === 'relative-goal-optimizer' ? 'Relative goal optimizer' : 'Upstream Chat2Scenic · research'}</strong><span>{result.model}</span><span>{(result.metrics.latencyMs / 1000).toFixed(1)} s</span></div>
      {result.warnings.map((warning) => <div key={warning} style={styles.warning}>{warning}</div>)}
      <details style={styles.intent} open>
        <summary><strong>Review structured intent</strong> · editable before regeneration</summary>
        <textarea aria-label="Structured scenario intent" className="studio-field" style={styles.intentEditor} value={intentDraft} onChange={(event) => setIntentDraft(event.currentTarget.value)} />
        <button type="button" className="studio-btn" style={styles.secondary} onClick={regenerateIntent}>Regenerate from edited intent</button>
      </details>
      <div style={styles.candidates}>
        {result.candidates.map((candidate) => {
          const validation = validations[candidate.id];
          return <article key={candidate.id} style={styles.card} data-testid="scenario-copilot-candidate">
            <div style={styles.cardTitle}><strong>{candidate.title}</strong><span>{candidate.scenarioDoc.roles.length} actors</span></div>
            <p>{candidate.summary}</p>
            <div style={validation === 'running' || !validation ? styles.validating : validation.valid ? styles.valid : styles.invalid}>
              {validation === 'running' || !validation ? 'Running canonical simulation…' : validation.message}
            </div>
            <div style={styles.provenance}>Map {candidate.provenance.mapId} · examples {candidate.provenance.retrievedExampleIds.join(', ') || 'none'} · {candidate.provenance.implementation}</div>
            {candidate.provenance.researchDetails ? <div style={styles.researchEvidence}>
              Scenic {candidate.provenance.researchDetails.scenicVersion ?? 'unavailable'} · compiled {candidate.provenance.researchDetails.scenicCompiled ? 'yes' : 'no'} · sampled {candidate.provenance.researchDetails.scenicSampled ? 'yes' : 'no'} · {candidate.provenance.researchDetails.apiCalls} model calls
            </div> : null}
            {candidate.provenance.agentDetails ? <details style={styles.agentEvidence}>
              <summary>{candidate.provenance.agentDetails.iterations.length} agent iteration(s) · {candidate.provenance.agentDetails.reasoningEffort} effort · {candidate.provenance.agentDetails.stopReason}</summary>
              {candidate.provenance.agentDetails.iterations.map((iteration) => <div key={iteration.iteration} style={styles.agentIteration}>
                <strong>Iteration {iteration.iteration}</strong> · {(iteration.durationMs / 1000).toFixed(1)}s · {iteration.totalTokens.toLocaleString()} tokens
                <div>{iteration.draftDiff.join(' · ') || 'No typed draft delta'}</div>
                <div>{iteration.toolCalls.map((call) => `${call.ok ? '✓' : '✕'} ${call.name}`).join(' · ')}</div>
                {iteration.semanticChecks.filter((check) => !check.pass).map((check) => <div key={check.id} style={styles.invalid}>{check.id}: {check.evidence}</div>)}
              </div>)}
            </details> : null}
            {candidate.provenance.optimizerDetails ? <details style={styles.agentEvidence}>
              <summary>1 intent call · {candidate.provenance.optimizerDetails.evaluations.length}/{candidate.provenance.optimizerDetails.evaluationBudget} native evaluations · {candidate.provenance.optimizerDetails.stopReason}</summary>
              {candidate.provenance.optimizerDetails.evaluations.slice(0, 12).map((evaluation) => <div key={evaluation.index} style={styles.agentIteration}>
                <strong>Evaluation {evaluation.index}</strong> · score {evaluation.score} · {evaluation.simulationPass ? '20s simulation' : 'rejected'}
                <div>{evaluation.parameterChanges.join(' · ')}</div>
                <div>Relative triggers {evaluation.relativeTriggers.fired}/{evaluation.relativeTriggers.authored} · collisions {evaluation.collisions}</div>
                {evaluation.diagnostic ? <div style={styles.invalid}>{evaluation.diagnostic}</div> : null}
              </div>)}
            </details> : null}
            <button type="button" data-testid="scenario-copilot-apply" className="studio-btn" style={styles.apply} disabled={!validation || validation === 'running' || !validation.valid} onClick={() => onApply(candidate)}>Apply & open in editor</button>
          </article>;
        })}
      </div>
    </> : null}
    <footer style={styles.caveat}>Structured + retrieval is the clean-room implementation. Upstream Chat2Scenic runs a separately attributed, pinned CC BY-NC 4.0 research adapter; it is not part of the production browser bundle and must not be used commercially.</footer>
  </section>;
}

const styles: Record<string, CSSProperties> = {
  panel: { padding: 18, color: 'var(--ueui-text, #f2f2f2)', display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0, maxHeight: 'calc(100vh - 96px)', overflowY: 'auto', boxSizing: 'border-box', height: '100%', background: 'linear-gradient(180deg, var(--ueui-glass-high, rgba(19, 24, 32, 0.92)), var(--ueui-glass-low, rgba(8, 11, 16, 0.94)))', backdropFilter: 'blur(72px) saturate(185%)', WebkitBackdropFilter: 'blur(72px) saturate(185%)', border: '1px solid var(--ueui-line-strong, rgba(255,255,255,.14))', borderRadius: 'var(--ueui-radius, 10px)', boxShadow: 'var(--ueui-shadow, 0 18px 48px rgba(0,0,0,.55))' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', borderBottom: '1px solid var(--ueui-line, rgba(255,255,255,.08))', paddingBottom: 12 },
  eyebrow: { color: 'var(--ueui-accent, #e8e044)', fontSize: 11, letterSpacing: 1.5, fontWeight: 700 }, heading: { margin: '3px 0 0', fontSize: 24 },
  close: { border: 0, background: 'transparent', color: 'var(--ueui-text-muted, #9a9a9a)', fontSize: 27, cursor: 'pointer' },
  mapLock: { display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: 10, alignItems: 'center', padding: 11, border: '1px solid var(--ueui-line, rgba(255,255,255,.08))', borderRadius: 'var(--ueui-radius, 10px)', background: 'rgba(255,255,255,.03)' },
  tabs: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 5, padding: 4, background: 'rgba(8, 11, 16, 0.55)', borderRadius: 8 }, tab: { padding: 8, border: 0, borderRadius: 6, background: 'transparent', color: 'var(--ueui-text-muted, #9a9a9a)', fontWeight: 650, cursor: 'pointer' }, tabActive: { color: '#10120a', background: 'var(--ueui-accent, #e8e044)' }, rerunNotice: { display: 'flex', justifyContent: 'space-between', gap: 8, padding: 9, borderRadius: 7, background: 'rgba(240,161,60,.12)', color: 'var(--ueui-warn, #f0a13c)', fontSize: 11 },
  lock: { color: 'var(--ueui-accent, #e8e044)', fontSize: 12, fontWeight: 700 },
  label: { fontSize: 12, color: 'rgba(242,242,242,.82)', fontWeight: 650 }, providers: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8 },
  provider: { color: 'rgba(242,242,242,.85)', textAlign: 'left', padding: 10, display: 'flex', flexDirection: 'column', gap: 4, background: 'rgba(255,255,255,.03)', borderWidth: 1, borderStyle: 'solid', borderColor: 'var(--ueui-line, rgba(255,255,255,.08))', borderRadius: 'var(--ueui-radius, 10px)', cursor: 'pointer' },
  providerActive: { borderColor: 'rgba(232,224,68,.5)', background: 'var(--ueui-accent-soft, rgba(232,224,68,.16))' }, prompt: { minHeight: 108, resize: 'vertical', borderRadius: 8, padding: 11 },
  generate: { padding: '11px 14px', border: '1px solid transparent', borderRadius: 8, background: 'var(--ueui-accent, #e8e044)', color: '#10120a', fontWeight: 750, cursor: 'pointer' },
  progress: { display: 'flex', justifyContent: 'space-between', color: 'var(--ueui-text-muted, #9a9a9a)', background: 'rgba(255,255,255,.04)', padding: 9, borderRadius: 7, fontSize: 12 },
  error: { padding: 10, borderRadius: 7, background: 'rgba(255,107,94,.12)', color: 'var(--ueui-danger, #ff6b5e)' }, warning: { padding: 9, borderRadius: 7, background: 'rgba(240,161,60,.12)', color: 'var(--ueui-warn, #f0a13c)', fontSize: 12 },
  runMeta: { display: 'flex', gap: 10, flexWrap: 'wrap', color: 'var(--ueui-text-muted, #9a9a9a)', fontSize: 12 }, intent: { border: '1px solid var(--ueui-line, rgba(255,255,255,.08))', borderRadius: 'var(--ueui-radius, 10px)', padding: 10, background: 'rgba(255,255,255,.03)' },
  intentEditor: { marginTop: 9, boxSizing: 'border-box', width: '100%', minHeight: 170, resize: 'vertical', padding: 9, fontFamily: 'ui-monospace, monospace', fontSize: 11 },
  secondary: { marginTop: 8, padding: '7px 10px', borderRadius: 8, border: '1px solid var(--ueui-line-strong, rgba(255,255,255,.14))', background: 'rgba(255,255,255,.05)', color: 'var(--ueui-text, #f2f2f2)', cursor: 'pointer' },
  candidates: { display: 'grid', gap: 10 }, card: { padding: 12, border: '1px solid var(--ueui-line, rgba(255,255,255,.08))', borderRadius: 'var(--ueui-radius, 10px)', background: 'linear-gradient(180deg, rgba(255,255,255,.035), rgba(255,255,255,.012))' }, cardTitle: { display: 'flex', justifyContent: 'space-between', gap: 8 },
  validating: { color: 'var(--ueui-text-muted, #9a9a9a)', fontSize: 12 }, valid: { color: 'var(--ueui-ok, #57c785)', fontSize: 12 }, invalid: { color: 'var(--ueui-danger, #ff6b5e)', fontSize: 12 },
  provenance: { marginTop: 8, color: 'var(--ueui-text-muted, #9a9a9a)', fontSize: 10, overflowWrap: 'anywhere' }, apply: { marginTop: 10, width: '100%', padding: 9, border: '1px solid transparent', borderRadius: 8, background: 'var(--ueui-accent, #e8e044)', color: '#10120a', fontWeight: 700, cursor: 'pointer' },
  researchEvidence: { marginTop: 7, padding: 7, borderRadius: 7, color: 'var(--ueui-warn, #f0a13c)', background: 'rgba(240,161,60,.1)', fontSize: 10 },
  agentEvidence: { marginTop: 7, padding: 7, borderRadius: 7, color: 'rgba(242,242,242,.82)', background: 'rgba(255,255,255,.04)', fontSize: 10 },
  agentIteration: { marginTop: 6, paddingTop: 6, borderTop: '1px solid var(--ueui-line, rgba(255,255,255,.08))', lineHeight: 1.5 },
  caveat: { color: 'var(--ueui-text-muted, #9a9a9a)', fontSize: 10, lineHeight: 1.45, borderTop: '1px solid var(--ueui-line, rgba(255,255,255,.08))', paddingTop: 10 },
};
