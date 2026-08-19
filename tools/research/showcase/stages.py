#!/usr/bin/env python3
"""Thin, JSON-speaking adapters for the showcase pipeline.

The protected research implementations remain the source of truth.  This file
only adapts their callable functions to one-brief / one-job invocations.
"""

import argparse
import contextlib
import io
import gzip
import json
import os
import pathlib
import shutil
import sys
import subprocess
import tempfile
import time

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[2]
GATES = ROOT / 'tools' / 'gates'
VISTA2 = ROOT / 'tools' / 'research' / 'vista2'
FOOTAGE = ROOT / 'tools' / 'research' / 'footage'
sys.path.insert(0, str(GATES))
import review_contract as review
import semantic_contract as semantic


def emit(value):
    print(json.dumps(value, separators=(',', ':')))


def load(path):
    with open(path, encoding='utf-8') as handle:
        return json.load(handle)


def atomic_json(path, value):
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name('.%s.%d.tmp' % (path.name, os.getpid()))
    with open(temp, 'w', encoding='utf-8') as handle:
        json.dump(value, handle, indent=2)
        handle.write('\n')
    os.replace(temp, path)


def atomic_copy(source, target):
    target = pathlib.Path(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    temp = target.with_name('.%s.%d.tmp' % (target.name, os.getpid()))
    shutil.copyfile(source, temp)
    os.replace(temp, target)


def enforce_minimum_clip(path, minimum_seconds=20.0):
    template = load(path)
    choreography = template.setdefault('choreography', {})
    authored = float(choreography.get('clipSeconds', minimum_seconds))
    choreography['clipSeconds'] = max(minimum_seconds, authored)
    atomic_json(path, template)
    return choreography['clipSeconds']



def precheck(args):
    import precheck_briefs as module

    brief = load(args.brief)
    inventory = load(module.INVENTORY) if os.path.exists(module.INVENTORY) else module.measure_inventory()
    result = module.precheck(brief, inventory)
    result['inventoryFile'] = os.path.relpath(module.INVENTORY, ROOT)
    result['implementation'] = 'tools/gates/precheck_briefs.py:precheck'
    emit(result)

def contract(args):
    import precheck_briefs as module

    brief = load(args.brief)
    emit(semantic.derive_contract(brief, module.required_structures(brief)))


def validate_contract(args):
    template, added_invariants = semantic.complete_template(load(args.template))
    if added_invariants:
        atomic_json(pathlib.Path(args.template), template)
    failures = semantic.validate_template(template, load(args.contract))
    emit({'valid': not failures, 'failures': failures,
          'representationDefaults': {'invariants': added_invariants}})





def author(args):
    # author_llm reads these at import time through its unchanged vlm module.
    os.environ['VISTA_MODEL'] = args.model
    os.environ['VISTA_EFFORT'] = args.effort
    import author_llm as module
    import httpx

    brief = load(args.brief)
    out = pathlib.Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    captured = io.StringIO()
    usage = {'calls': 0, 'input_tokens': 0, 'output_tokens': 0,
             'reasoning_tokens': 0, 'wallS': 0.0}
    original_post = httpx.post

    def observed_post(url, **kwargs):
        call_started = time.monotonic()
        response = original_post(url, **kwargs)
        usage['calls'] += 1
        usage['wallS'] += time.monotonic() - call_started
        try:
            provider = response.json().get('usage') or {}
        except Exception:  # noqa: BLE001
            provider = {}
        usage['input_tokens'] += provider.get('input_tokens') or 0
        usage['output_tokens'] += provider.get('output_tokens') or 0
        usage['reasoning_tokens'] += (
            (provider.get('output_tokens_details') or {}).get('reasoning_tokens') or 0)
        return response

    started = time.monotonic()
    httpx.post = observed_post
    try:
        with contextlib.redirect_stdout(captured), contextlib.redirect_stderr(captured):
            row = module.author_brief(
                brief,
                probe_draws=args.probe_draws,
                final_draws=args.draws,
                max_sites=args.max_sites,
                concurrency=args.concurrency,
                log_dir=None,
            )
    finally:
        httpx.post = original_post
    usage['wallS'] = round(usage['wallS'], 3)
    transcript = {
        'implementation': 'tools/gates/author_llm.py:author_brief',
        'model': args.model,
        'effort': args.effort,
        'wallS': round(time.monotonic() - started, 3),
        'usage': usage,
        'brief': brief,
        'result': row,
        'log': captured.getvalue()[-20000:],
    }
    atomic_json(out / 'transcript.json', transcript)
    template = row.get('template')
    if not template or not os.path.isfile(template):
        reason = row.get('detail') or row.get('error', 'unknown error')
        raise RuntimeError('compiler produced no reusable template: %s' % reason)
    atomic_copy(template, out / 'template.json')
    clip_seconds = enforce_minimum_clip(out / 'template.json')
    emit({'template': str(out / 'template.json'), 'transcript': str(out / 'transcript.json'),
          'admitted': bool(row.get('admitted')), 'family': row.get('family'),
          'clipSeconds': clip_seconds})


def vista_author(args):
    os.environ.setdefault('OPENAI_BASE_URL', 'http://127.0.0.1:4141/v1')
    os.environ.setdefault('OPENAI_API_KEY', 'x')
    sys.path.insert(0, str(VISTA2))
    import run_vista2
    import vagent

    original_brief = load(args.brief)
    author_contract = load(args.contract)
    out = pathlib.Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    guide_source = pathlib.Path('/tmp/tgr-vista-main1/GUIDE.md')
    attempts = []
    failures = []
    final_row = None
    final_template = None
    run_vista2.preflight(args.model, args.effort)

    for attempt_index in range(args.retries + 1):
        attempt_dir = out / f'attempt-{attempt_index + 1:02d}'
        attempt_dir.mkdir(parents=True, exist_ok=True)
        guide_out = attempt_dir / 'GUIDE.md'
        if guide_source.is_file():
            shutil.copyfile(guide_source, guide_out)
        else:
            guide_out.write_text('', encoding='utf-8')
        brief = json.loads(json.dumps(original_brief))
        brief['showcaseContract'] = author_contract
        brief['id'] = f'{original_brief["id"]}-attempt-{attempt_index + 1:02d}'
        brief['brief'] = original_brief['brief'] + '\n\n' + semantic.repair_prompt(author_contract, failures)
        llm = vagent.LLM(args.model, args.effort, str(attempt_dir / 'llm.jsonl'))
        episode = vagent.Episode(brief, str(attempt_dir), llm, str(guide_out),
                                 budget=args.budget, wall_cap_s=2400)
        started = time.monotonic()
        row = episode.run()
        row['wallSAdapter'] = round(time.monotonic() - started, 3)
        row['implementation'] = 'tools/research/vista2/vagent.py:Episode'
        result = episode.emit_result or {}
        template_source = result.get('template')
        failures = []
        if not template_source or not os.path.isfile(template_source):
            failures = [{'kind': 'missing_template', 'reason': 'vista2 episode produced no emitted template'}]
        else:
            candidate = attempt_dir / 'candidate.template.json'
            atomic_copy(template_source, candidate)
            enforce_minimum_clip(candidate)
            candidate_template, _ = semantic.complete_template(load(candidate))
            atomic_json(candidate, candidate_template)
            failures = semantic.validate_template(candidate_template, author_contract)
            if not row.get('admitted'):
                failures.append({
                    'kind': 'frozen_gate_admission',
                    'reason': 'author emitted a structurally complete template but no cell passed the frozen gate',
                })
            if not failures:
                final_row = row
                final_template = candidate
        attempts.append({
            'attempt': attempt_index + 1,
            'briefId': brief['id'],
            'row': row,
            'contractFailures': failures,
            'template': str(template_source) if template_source else None,
        })
        atomic_json(out / 'contract-attempts.json', {
            'contract': author_contract,
            'attempts': attempts,
            'acceptedAttempt': attempt_index + 1 if final_template else None,
        })
        if final_template:
            break

    if final_template is None:
        raise RuntimeError('vista2 exhausted semantic-contract repairs: %s' % json.dumps(failures))
    atomic_copy(final_template, out / 'template.json')
    atomic_json(out / 'transcript.json', {
        'contract': author_contract,
        'attempts': attempts,
        'acceptedAttempt': len(attempts),
        'result': final_row,
    })
    emit({'template': str(out / 'template.json'), 'transcript': str(out / 'transcript.json'),
          'contractAttempts': str(out / 'contract-attempts.json'),
          'admitted': bool(final_row.get('admitted')), 'actions': final_row.get('actions'),
          'clipSeconds': load(out / 'template.json')['choreography']['clipSeconds']})


def gate(args):
    import tg_gate

    request = load(args.request)
    rows = []
    for cell in request['cells']:
        trace = cell.get('traceFile')
        if not trace or not os.path.isfile(trace):
            rows.append({'cellId': cell['cellId'], 'pass': False, 'firstFailure': 'NOTRACE',
                         'error': 'trace missing'})
            continue
        verdict = cell.get('verdict')
        band = cell.get('band')
        result = tg_gate.gate_cell(trace, verdict=verdict, band=band,
                                   brief=request.get('brief'), version=2)
        result['cellId'] = cell['cellId']
        result['mapId'] = cell.get('mapId')
        result['siteId'] = cell.get('siteId')
        result['drawIndex'] = cell.get('drawIndex')
        result['firstFailure'] = tg_gate.first_failure(result)
        rows.append(result)
    emit({'implementation': 'tools/gates/tg_gate.py:gate_cell', 'version': 2, 'cells': rows})


def judge(args):
    sys.path.insert(0, str(FOOTAGE))
    import judge as module

    cell = pathlib.Path(args.cell)
    render = pathlib.Path(args.render)
    with tempfile.TemporaryDirectory(prefix='showcase-judge-') as tmp:
        staged = pathlib.Path(tmp)
        shutil.copyfile(cell / 'meta.json', staged / 'meta.json')
        os.symlink(render, staged / 'render', target_is_directory=True)
        result = module.judge_cell(str(staged), args.model, args.effort, args.strategy,
                                   require_redacted=True)
    # The blind judge never sees the brief, so its verdict is presentation-tier evidence only.
    result['tier'] = '2d'
    emit(result)


# Loop-control oracle for the generation benchmark: brief-aware review of the
# cheap 2D schematic footage. Deliberately NOT the hashed acceptance contract --
# schematic footage has no assets, camera, or lighting, so realism and every
# presentation axis are out of scope here. `semanticMatch` gates 3D spend and
# drives template mutation; contract acceptance still happens at 70-judge.
SEMANTIC2D_PROMPT = """You are reviewing a top-down SCHEMATIC 2D rendering of a simulated traffic scenario.
The rendering is deliberately abstract: boxes for vehicles, dots for pedestrians, plain road geometry.
Never judge visual quality, detail, lighting, or realism of the drawing itself.

Judge ONLY what the traffic does, against the user's exact request:
1. mechanismFidelity: Does the visible motion implement the exact requested causal mechanism
   (yes|partial|no)? A generic near-miss or route-around that ignores the requested cause is "no".
2. actorFidelity: Are the requested actor types present and behaving as the request needs (pass|fail)?
3. eventSequence: Do the requested onset, conflict, and reaction happen in that order (pass|fail)?
4. plausible: Could real traffic move this way (true|false)?

Report only defects about the traffic behaviour, each with one code:
  scenario.mechanism      requested causal mechanism absent, replaced, or routed around
  scenario.actors         wrong, missing, or substituted requested actor type
  scenario.sequence       onset, conflict, or reaction out of order or absent
  scenario.trigger        a scripted reaction never happens
  scenario.plausibility   behaviour that could not happen in real traffic

Answer STRICT JSON only:
{"mechanismFidelity":"yes|partial|no","actorFidelity":"pass|fail","eventSequence":"pass|fail",
"plausible":true,"confidence":0.0,
"defects":[{"code":"scenario.…","text":"short observed behaviour defect"}],
"explanation":"2-4 sentences on what the traffic visibly does versus what was requested"}"""

SEMANTIC2D_CONFIDENCE_MIN = 0.6


def semantic2d_verdict(emission):
    """Deterministic loop-control verdict over a semantic 2D emission."""
    codes = sorted({item.get('code') for item in emission.get('defects', [])
                    if isinstance(item, dict) and isinstance(item.get('code'), str)
                    and item['code'].startswith('scenario.')})
    match = (emission.get('mechanismFidelity') == 'yes'
             and emission.get('actorFidelity') == 'pass'
             and emission.get('eventSequence') == 'pass'
             and emission.get('plausible') is True
             and (emission.get('confidence') or 0.0) >= SEMANTIC2D_CONFIDENCE_MIN
             and not codes)
    return {'semanticMatch': bool(match), 'scenarioDefectCodes': codes}


def _select_review_frames(frames_dir, count=8):
    """Evenly spaced PNG keyframes across the full clip, first and last included."""
    frames = sorted(frames_dir.glob('frame-*.png'))
    if len(frames) <= count:
        return frames
    last = len(frames) - 1
    return [frames[round(last * index / (count - 1))] for index in range(count)]


def _authored_scene_evidence(instance_path, trace_path):
    instance = load(instance_path)
    authored = [actor for actor in instance.get('input', {}).get('actors', [])
                if not str(actor.get('id', '')).startswith('ambient:')]
    authored_ids = {actor['id'] for actor in authored}
    evidence = {
        'authoredActors': [
            {'id': actor['id'], 'kind': actor.get('kind'), 'catalogId': actor.get('catalogId')}
            for actor in authored
        ],
    }
    if trace_path and os.path.isfile(trace_path):
        with gzip.open(trace_path, 'rt', encoding='utf-8') as handle:
            trace = json.load(handle)
        evidence['traceFacts'] = {
            'collisions': trace.get('metrics', {}).get('collisions', []),
            'events': [
                event for event in trace.get('events', [])
                if event.get('actorId') in authored_ids and event.get('kind') in
                ('trigger_fired', 'trigger_skipped', 'released')
            ],
        }
    return evidence


def semantic_2d(args):
    sys.path.insert(0, str(FOOTAGE))
    import futil

    futil.assert_vision_session(args.model)
    brief = load(args.brief)
    render = pathlib.Path(args.render)
    frames = [frame for frame in _select_review_frames(render / 'frames') if frame.is_file()]
    if not frames:
        raise RuntimeError(f'no 2D review frames in {render}')
    cell = pathlib.Path(args.cell)
    evidence = _authored_scene_evidence(cell / 'instance.json', cell / 'trace.json.gz')
    request_text = args.request_text or brief['brief']
    prompt = (f'{SEMANTIC2D_PROMPT}\n\nUSER REQUEST:\n{request_text}'
              f'\n\nGROUND-TRUTH EVIDENCE:\n{json.dumps(evidence, separators=(",", ":"))}')
    content = [{'type': 'input_text', 'text': prompt}]
    content.extend({'type': 'input_image', 'image_url': futil.png_data_url(str(frame))}
                   for frame in frames)
    body = {
        'model': args.model,
        'reasoning': {'effort': args.effort},
        'max_output_tokens': 3000,
        'input': [{'role': 'user', 'content': content}],
    }
    response, raw, wall = futil.responses_call(body, timeout=420)
    parsed = futil.parse_json_block(futil.output_text(response))
    emission = {'tier': '2d-semantic'}
    for axis in ('mechanismFidelity', 'actorFidelity', 'eventSequence'):
        if axis in parsed:
            emission[axis] = str(parsed.get(axis) or '').strip().lower()
    if 'plausible' in parsed:
        emission['plausible'] = bool(parsed['plausible'])
    if 'confidence' in parsed:
        emission['confidence'] = review.clamp_number(parsed['confidence'], 0.0, 1.0)
    emission['defects'] = raw_defects(parsed.get('defects'))
    emission['explanation'] = str(parsed.get('explanation', ''))[:2000]
    usage = response.get('usage') or {}
    emit({
        'cellId': args.cell_id,
        'model': args.model,
        'effort': args.effort,
        'visionAsserted': True,
        **emission,
        **semantic2d_verdict(emission),
        'framesUsed': [str(frame.relative_to(render)) for frame in frames],
        'latencyS': round(wall, 2),
        'tokens': {
            'in': usage.get('input_tokens'),
            'out': usage.get('output_tokens'),
            'reasoning': (usage.get('output_tokens_details') or {}).get('reasoning_tokens'),
        },
        'rawResponseSha256': futil.sha256_text(raw),
    })


MUTATE_PROMPT = """You are repairing an executable autonomous-driving scenario template.
A brief-aware reviewer watched the simulated footage of this exact template and found the
scenario semantics wrong. Repair the TEMPLATE so the simulated traffic visibly enacts the
user's request. This is a surgical edit, not a rewrite:
- Keep the same JSON schema, top-level keys, anchor, roles, and site constraints.
- Change only actor placement/speeds, choreography interactions (triggers, verbs, targets,
  dynamics, timing), params, and props when they are the reason the semantics failed.
- The requested onset must visibly precede the reaction inside the clip window.
- The scenario must STAY critical: the ego must still face a genuine imminent conflict that
  forces real braking or steering. A repair that makes everything slow, distant, or gentle
  will be rejected by the frozen criticality gate. `priorRepairFailures` in the feedback
  lists exactly how earlier repairs of this template failed; do not repeat them.
- Every reviewer defect below must be addressed by a concrete field change.
Return ONLY the complete corrected template JSON."""


def mutate(args):
    sys.path.insert(0, str(FOOTAGE))
    import futil

    original = load(args.template)
    author_contract = load(args.contract)
    brief = load(args.brief)
    feedback = load(args.feedback)
    out = pathlib.Path(args.out)
    prompt = (
        f'{MUTATE_PROMPT}\n\nUSER REQUEST:\n{brief["brief"]}'
        f'\n\nEXECUTABLE SEMANTIC CONTRACT (must stay satisfied):\n'
        f'{json.dumps(author_contract, separators=(",", ":"))}'
        f'\n\nREVIEWER FEEDBACK ON THE SIMULATED FOOTAGE:\n'
        f'{json.dumps(feedback, separators=(",", ":"))}'
        f'\n\nCURRENT TEMPLATE:\n{json.dumps(original, separators=(",", ":"))}'
    )
    body = {
        'model': args.model,
        'reasoning': {'effort': args.effort},
        'max_output_tokens': 16000,
        'input': [{'role': 'user', 'content': [{'type': 'input_text', 'text': prompt}]}],
    }
    response, raw, wall = futil.responses_call(body, timeout=420)
    parsed = futil.parse_json_block(futil.output_text(response))
    if not isinstance(parsed, dict) or 'choreography' not in parsed:
        raise RuntimeError('mutation returned no template JSON')
    template, _ = semantic.complete_template(parsed)
    atomic_json(out, template)
    enforce_minimum_clip(out)
    failures = semantic.validate_template(load(out), author_contract)
    usage = response.get('usage') or {}
    emit({
        'template': str(out),
        'valid': not failures,
        'failures': failures,
        'latencyS': round(wall, 2),
        'usage': {
            'calls': 1,
            'input_tokens': usage.get('input_tokens') or 0,
            'output_tokens': usage.get('output_tokens') or 0,
            'reasoning_tokens': (usage.get('output_tokens_details') or {}).get('reasoning_tokens') or 0,
            'wallS': round(wall, 3),
        },
    })


def raw_defects(value):
    """Preserve the reviewer's defect evidence verbatim: text, declared code, confidence."""
    if not isinstance(value, list):
        return []
    records = []
    for item in value[:review.MAX_DEFECTS]:
        if not isinstance(item, dict):
            records.append(str(item)[:review.MAX_TEXT])
            continue
        record = {'text': str(item.get('text') or item.get('defect')
                              or item.get('description') or '')[:review.MAX_TEXT]}
        if isinstance(item.get('code'), str):
            record['code'] = item['code'].strip()
        if item.get('confidence') is not None:
            record['confidence'] = review.clamp_number(item['confidence'], 0.0, 1.0)
        records.append(record)
    return records

def _video_seek_time(simulation_t, video_start_t):
    """Translate an absolute simulation timestamp into the clipped video's timebase."""
    return max(0.0, float(simulation_t) - float(video_start_t))



def review_3d(args):
    sys.path.insert(0, str(FOOTAGE))
    import futil

    futil.assert_vision_session(args.model)
    brief = load(args.brief)
    render = pathlib.Path(args.render)
    manifest = load(render / 'manifest.json')
    video_records = manifest.get('videoSequence', {}).get('frames', [])
    video_start_t = manifest.get('videoSequence', {}).get('startT', 0)
    phase_times = [row.get('t') for row in manifest.get('frames', [])
                   if isinstance(row.get('t'), (int, float))]
    candidates = []
    review_tmp = None
    if video_records and phase_times and (render / 'video.mp4').is_file():
        start_t, end_t = min(phase_times), max(phase_times)
        targets = [start_t + (end_t - start_t) * index / 7 for index in range(8)]
        selected = []
        for target in targets:
            record = min(video_records, key=lambda row: abs(row.get('t', target) - target))
            if record.get('sequenceIndex') not in [row.get('sequenceIndex') for row in selected]:
                selected.append(record)
        review_tmp = tempfile.TemporaryDirectory(prefix='.review-frames-', dir=render)
        try:
            for ordinal, record in enumerate(selected):
                retained = render / 'video-frames' / f'frame-{record["sequenceIndex"]:05d}.png'
                if retained.is_file():
                    candidates.append(retained)
                    continue
                frame = pathlib.Path(review_tmp.name) / f'frame-{ordinal:02d}.png'
                seek_t = _video_seek_time(record['t'], video_start_t)
                subprocess.run([
                    'ffmpeg', '-y', '-hide_banner', '-loglevel', 'error',
                    '-ss', str(seek_t), '-i', str(render / 'video.mp4'),
                    '-frames:v', '1', str(frame),
                ], check=True)
                if not frame.is_file():
                    raise FileNotFoundError(f'ffmpeg wrote no frame at video t={seek_t}')
                candidates.append(frame)
        except (OSError, subprocess.CalledProcessError, KeyError):
            candidates = []
    # A render whose encoded frame sequence is unavailable is still reviewable
    # from the four named phase stills, but that is a weaker basis and the
    # verdict has to say so rather than pretend otherwise.
    frame_basis = 'video-sequence' if candidates else 'named-phase-stills'
    if not candidates:
        candidates = [
            render / 'frames' / 'frame-000.png',
            render / 'frames' / 'frame-001.png',
            render / 'frame.png',
            render / 'frames' / 'frame-003.png',
        ]
    frames = []
    seen = set()
    for frame in candidates:
        if frame.is_file() and frame.resolve() not in seen:
            seen.add(frame.resolve())
            frames.append(frame)
    if not frames:
        raise RuntimeError(f'no 3D review frames in {render}')
    instance = load(render / 'source' / 'instance.json')
    authored_ids = [actor['id'] for actor in instance.get('input', {}).get('actors', [])
                    if not actor.get('id', '').startswith('ambient:')]
    frame_context = []
    for record in manifest.get('frames', []):
        visible = []
        for actor in record.get('composition', {}).get('actors', []):
            if actor.get('id') in authored_ids:
                visible.append({'id': actor['id'], 'pixel': actor.get('pixel')})
        frame_context.append({'phase': record.get('phase'), 't': record.get('t'), 'actors': visible})
    trace_context = {}
    trace_path = render / 'source' / 'trace.json.gz'
    if trace_path.is_file():
        with gzip.open(trace_path, 'rt', encoding='utf-8') as handle:
            trace = json.load(handle)
        metrics = trace.get('metrics', {})
        trace_context = {
            'declaredOcclusion': metrics.get('declaredOcclusion', []),
            'collisions': metrics.get('collisions', []),
            'events': [
                event for event in trace.get('events', [])
                if event.get('actorId') in authored_ids and event.get('kind') in
                ('trigger_fired', 'trigger_skipped', 'released')
            ],
        }
    evidence = {
        'authoredActors': [
            {'id': actor['id'], 'kind': actor.get('kind'), 'catalogId': actor.get('catalogId')}
            for actor in instance.get('input', {}).get('actors', [])
            if actor.get('id') in authored_ids
        ],
        'frameOrder': frame_context,
        'traceFacts': trace_context,
    }
    request_text = args.request_text or brief['brief']
    prompt = (f'{review.PROMPT}\n\nUSER REQUEST:\n{request_text}'
              f'\n\nGROUND-TRUTH EVIDENCE:\n{json.dumps(evidence, separators=(",", ":"))}')
    content = [{'type': 'input_text', 'text': prompt}]
    content.extend({'type': 'input_image', 'image_url': futil.png_data_url(str(frame))}
                   for frame in frames)
    body = {
        'model': args.model,
        'reasoning': {'effort': args.effort},
        'max_output_tokens': 4000,
        'input': [{'role': 'user', 'content': content}],
    }
    response, raw, wall = futil.responses_call(body, timeout=420)
    parsed = futil.parse_json_block(futil.output_text(response))
    # Only pass through what the reviewer actually answered: an omitted axis is unsupported
    # evidence, never a silent 'no'. The emission is evidence and nothing else -- the
    # acceptance verdict is derived exactly once, by whoever consumes it, so there is no
    # second copy for a normalization step to have to keep in agreement.
    emission = {'tier': review.FULL_TIER}
    for axis in ('mechanismFidelity', 'visualGrounding', 'actorFidelity', 'eventSequence'):
        if axis in parsed:
            emission[axis] = str(parsed.get(axis) or '').strip().lower()
    if 'plausible' in parsed:
        emission['plausible'] = bool(parsed['plausible'])
    if 'realism' in parsed:
        emission['realism'] = review.clamp_number(parsed['realism'], 0.0, 10.0)
    if 'confidence' in parsed:
        emission['confidence'] = review.clamp_number(parsed['confidence'], 0.0, 1.0)
    emission['defects'] = raw_defects(parsed.get('defects'))
    emission['explanation'] = str(parsed.get('explanation', ''))[:3000]
    usage = response.get('usage') or {}
    emit({
        'cellId': args.cell_id,
        'version': review.REVIEW_VERSION,
        'contract': review.contract_identity(),
        'model': args.model,
        'effort': args.effort,
        'visionAsserted': True,
        **emission,
        'frameBasis': frame_basis,
        'framesUsed': [str(frame.relative_to(render)) for frame in frames],
        'latencyS': round(wall, 2),
        'tokens': {
            'in': usage.get('input_tokens'),
            'out': usage.get('output_tokens'),
            'reasoning': (usage.get('output_tokens_details') or {}).get('reasoning_tokens'),
        },
        'rawResponseSha256': futil.sha256_text(raw),
    })
    if review_tmp is not None:
        review_tmp.cleanup()




def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)

    cmd = sub.add_parser('precheck')
    cmd.add_argument('--brief', required=True)
    cmd.set_defaults(func=precheck)

    cmd = sub.add_parser('contract')
    cmd.add_argument('--brief', required=True)
    cmd.set_defaults(func=contract)

    cmd = sub.add_parser('validate-contract')
    cmd.add_argument('--template', required=True)
    cmd.add_argument('--contract', required=True)
    cmd.set_defaults(func=validate_contract)

    cmd = sub.add_parser('author')
    cmd.add_argument('--brief', required=True)
    cmd.add_argument('--out', required=True)
    cmd.add_argument('--model', default='gpt-5.6-sol')
    cmd.add_argument('--effort', default='medium')
    cmd.add_argument('--probe-draws', type=int, default=1)
    cmd.add_argument('--draws', type=int, default=1)
    cmd.add_argument('--max-sites', type=int, default=3)
    cmd.add_argument('--concurrency', type=int, default=2)
    cmd.set_defaults(func=author)

    cmd = sub.add_parser('vista-author')
    cmd.add_argument('--brief', required=True)
    cmd.add_argument('--out', required=True)
    cmd.add_argument('--model', default='gpt-5.6-sol')
    cmd.add_argument('--contract', required=True)
    cmd.add_argument('--retries', type=int, default=2)
    cmd.add_argument('--effort', default='medium')
    cmd.add_argument('--budget', type=int, default=40)
    cmd.set_defaults(func=vista_author)

    cmd = sub.add_parser('gate')
    cmd.add_argument('--request', required=True)
    cmd.set_defaults(func=gate)

    cmd = sub.add_parser('judge')
    cmd.add_argument('--cell', required=True)
    cmd.add_argument('--render', required=True)
    cmd.add_argument('--model', default='gpt-5.6-sol')
    cmd.add_argument('--effort', default='medium')
    cmd.add_argument('--strategy', default='spread8')
    cmd.set_defaults(func=judge)

    cmd = sub.add_parser('semantic2d')
    cmd.add_argument('--brief', required=True)
    cmd.add_argument('--render', required=True)
    cmd.add_argument('--cell', required=True)
    cmd.add_argument('--cell-id', required=True)
    cmd.add_argument('--request-text')
    cmd.add_argument('--model', default='gpt-5.6-sol')
    cmd.add_argument('--effort', default='medium')
    cmd.set_defaults(func=semantic_2d)

    cmd = sub.add_parser('mutate')
    cmd.add_argument('--brief', required=True)
    cmd.add_argument('--contract', required=True)
    cmd.add_argument('--template', required=True)
    cmd.add_argument('--feedback', required=True)
    cmd.add_argument('--out', required=True)
    cmd.add_argument('--model', default='gpt-5.6-sol')
    cmd.add_argument('--effort', default='medium')
    cmd.set_defaults(func=mutate)

    cmd = sub.add_parser('review3d')
    cmd.add_argument('--brief', required=True)
    cmd.add_argument('--render', required=True)
    cmd.add_argument('--cell-id', required=True)
    cmd.add_argument('--request-text')
    cmd.add_argument('--model', default='gpt-5.6-sol')
    cmd.add_argument('--effort', default='medium')
    cmd.set_defaults(func=review_3d)

    args = parser.parse_args()
    args.func(args)


if __name__ == '__main__':
    main()
