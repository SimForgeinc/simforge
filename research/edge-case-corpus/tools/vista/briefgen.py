"""Generate NEW edge-case briefs, so the corpus is not capped at the 208 hand-written ones.

Brief supply is the binding constraint on volume: simulation runs at ~150 concrete scenarios/second,
authoring at ~204 s per template, so at any useful throughput the 208 fixed briefs are exhausted in
hours. This generates fresh ones, deduplicated against everything already seen.
"""
import os, sys, json, argparse, hashlib, random, re
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import vlm

TAXONOMY = {
    'C1.car-following': 'longitudinal conflicts with a lead vehicle',
    'C2.cut-in-merge': 'another vehicle moving laterally into the ego lane',
    'C3.intersection': 'crossing and turning conflicts at junctions',
    'C4.roundabout': 'circulating and entering conflicts at roundabouts',
    'C5.pedestrian': 'people on foot entering or occupying the carriageway',
    'C6.cyclist-ptw': 'cyclists, e-scooters and powered two-wheelers',
    'C7.occlusion': 'a hazard hidden until late by something blocking the sight line',
    'C8.workzone': 'roadworks, lane closures, tapers, workers on the road',
    'C9.hazard': 'objects, debris, animals, disabled vehicles and scene hazards',
    'C10.oncoming': 'conflicts with traffic coming the other way',
    'C11.parking': 'vehicles entering, leaving or manoeuvring in parking',
    'C12.school': 'school zones, buses, children, crossing guards',
    'C13.control': 'signals, signs and right-of-way control changing state',
    'C14.loss-of-control': 'another road user losing control of their vehicle',
    'C15.adversarial': 'deliberate or grossly negligent bad behaviour by others',
}

PROMPT = """You are writing briefs for an edge-case driving-scenario corpus used to test and train
autonomous vehicles. A brief is ONE sentence describing a specific dangerous situation the ego vehicle
must handle.

Write {n} new briefs in the category **{cat}** ({desc}).

## THE HARD CONSTRAINT: it must be buildable, or it is worthless
The simulator can only move road users around and change their rules. It has NO mechanical failure
model. Measured: 47% of rejected briefs failed purely because they named physics that cannot be built.

**The only things that exist:**
- actors: car, truck, bus, van, motorcycle, bicycle, pedestrian, scooter, animal, static_object
- specific models: sedan, suv, hatchback, pickup, van, box_truck, semi_truck, bus, ambulance,
  motorcycle, bicycle, mobility_scooter, tram; adult/child walking or standing; a traffic marshal
- what they can do: change speed, keep or close a gap, change lane, shift within a lane, follow a
  route, appear or disappear, and have their RULES changed - stop yielding, stop obeying signals,
  ignore other road users, become aggressive, react slowly, open a door, use indicators or hazards,
  brake lights, a marshal's stop paddle or gesture
- the world: weather, rain, fog, road friction, and traffic signal phases
- static props placed on or beside the road

**Therefore: describe what an outside observer SEES ROAD USERS DO. Never describe an internal
mechanical cause.** The simulator cannot burst a tyre, jackknife a trailer, detach a wheel, spill a
load, drop a branch, snap a chain, pop a bonnet, or lose traction on a grate. It CAN make a vehicle
swerve, brake, drift across a line, stop dead, or refuse to yield - which is what those events would
have LOOKED like anyway.

  BAD  "A wheel detaches from an oncoming car and rolls across the centreline."
  GOOD "An oncoming car drifts across the centreline into the ego's lane and does not correct."
  BAD  "The lead vehicle suffers a rear-tyre blowout that rapidly scrubs off speed."
  GOOD "The lead vehicle brakes abruptly to a near-stop in a live lane for no visible reason."
  BAD  "A motorcycle's front wheel drops into a drain grate, throwing the rider down."
  GOOD "A motorcycle ahead swerves sharply toward the kerb and stops across the ego's path."

Also: **there are no rail crossings, no school-zone markings and no work-zone markings on any map**, so
never require them as map features - build the situation from ordinary road structure, vehicles and
people.

**No vehicle in this simulator can reverse.** Measured: exactly 1 body in 1642 cells moved more than
0.8 m backwards. So never write a brief that needs a car to back out of a driveway or parking bay, or
to reverse in the carriageway. If you want that situation, describe what the ego encounters instead -
a vehicle already protruding from a driveway across the lane, or one stopped broadside in the road.

What else makes a good brief:
- it names a SPECIFIC observable event, not a vague danger. "A vehicle behaves unpredictably" is
  useless; "The lead brakes hard and stops in the lane while the ego is closing" is usable.
- the ego must be forced to react - brake hard, or pass within a couple of metres.
- it must be survivable by a competent driver. A guaranteed crash is not an edge case.
- prefer hidden, late-revealed or badly-behaved over merely fast.

These briefs ALREADY EXIST. Do not repeat them or write minor variations of them:
{existing}

Reply with ONLY a JSON array of {n} objects, no prose:
[{{"id": "<short-kebab-id, unique, prefixed {prefix}>", "category": "{cat}", "brief": "<one sentence>"}}]"""


def generate(n_per_category=4, categories=None, existing=None, out=None, seed=None):
    cats = categories or list(TAXONOMY)
    existing = existing or []
    seen_txt = {b['brief'].strip().lower() for b in existing}
    seen_ids = {b['id'] for b in existing}
    briefs = []
    for cat in cats:
        ex = [b['brief'] for b in existing if b.get('category') == cat]
        if seed is not None:
            random.Random(seed).shuffle(ex)
        prompt = PROMPT.format(n=n_per_category, cat=cat, desc=TAXONOMY[cat],
                               prefix=cat.split('.')[0].lower() + 'g-',
                               existing='\n'.join('  - ' + e for e in ex[:14]) or '  (none yet)')
        try:
            got, _ = vlm.ask_json(prompt, max_tokens=3000)
        except Exception as e:                                    # noqa: BLE001
            print(f'  {cat}: FAILED {e}', flush=True)
            continue
        if isinstance(got, dict):
            got = got.get('briefs') or got.get('items') or []
        kept = 0
        for b in got:
            if not isinstance(b, dict) or not b.get('brief'):
                continue
            txt = b['brief'].strip()
            if txt.lower() in seen_txt:
                continue
            bid = re.sub(r'[^a-z0-9-]', '', (b.get('id') or '').lower()) or (
                cat.split('.')[0].lower() + 'g-' + hashlib.sha1(txt.encode()).hexdigest()[:6])
            while bid in seen_ids:
                bid += '-' + hashlib.sha1(txt.encode()).hexdigest()[:3]
            seen_ids.add(bid)
            seen_txt.add(txt.lower())
            briefs.append({'id': bid, 'category': cat, 'brief': txt})
            kept += 1
        print(f'  {cat:22} +{kept}', flush=True)
    if out:
        json.dump({'briefs': briefs, 'split': {'GEN': [b['id'] for b in briefs]}},
                  open(out, 'w'), indent=1)
    return briefs


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--n', type=int, default=4, help='briefs per category')
    ap.add_argument('--out', required=True)
    ap.add_argument('--existing', default=('/Users/michaelvu-simforge/Documents/Programming/'
                                           'SimForge-vista/research/edge-case-corpus/'
                                           'agent-authoring/brief-corpus-full.json'))
    a = ap.parse_args()
    ex = json.load(open(a.existing))['briefs'] if os.path.exists(a.existing) else []
    bs = generate(a.n, existing=ex, out=a.out)
    print(f'\ngenerated {len(bs)} new briefs -> {a.out}')
