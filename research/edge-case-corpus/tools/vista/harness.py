"""Lane 2: the VISTA-style VISUAL authoring harness.

The agent SEES a top-down PNG, points at pixels, and the harness projects every pick to a
PORTABLE (laneOffset, s, tFrac) triple before emitting a ScenarioTemplate v2 (contract section 3).
No map coordinate and no road id ever reaches the template.

Loop: look -> place/act -> (re-render: the agent sees its own edit) -> test -> filmstrip -> adjust.
"""
import copy, glob, json, math, os, shutil, subprocess, time, hashlib

import render as R, route as RT, viz, gate as G

REPO = "/Users/maikyon/Documents/Programming/SimForge"
DEV = f"{REPO}/dev-assets"
CLI = [ "node", f"{REPO}/packages/cli/bin/simforge.js" ]
MAPS = ['yale-street','belmont-research-center','el-camino-road','easterbrook-discovery-school','richmond-field-station']

S0 = 120.0           # the conflict station in the site frame; view is centred here
CLIP = 13.0
WARMUP = 1.5
APPROACH_S = 8.0     # ego starts this many seconds of travel upstream of S0
EGO_SPEED = "clamp(0.75 * lane.speedLimitKph, 20, 45)"

CATALOG_DIMS = {
 'vehicle.sedan':(4.8,1.9,'car'), 'vehicle.suv':(4.85,1.95,'car'), 'vehicle.hatchback':(4.2,1.8,'car'),
 'vehicle.pickup':(5.6,2.0,'car'), 'vehicle.van':(5.4,2.0,'car'), 'vehicle.box_truck':(7.6,2.4,'car'),
 'vehicle.semi_truck':(16.0,2.55,'car'), 'vehicle.bus':(12.0,2.55,'car'), 'vehicle.ambulance':(6.2,2.3,'car'),
 'vehicle.bicycle':(1.8,0.6,'bicycle'), 'vehicle.motorcycle':(2.1,0.8,'car'),
 'vehicle.mobility_scooter':(1.2,0.7,'car'), 'vehicle.tram':(20.0,2.6,'car'),
 'pedestrian.adult_walking':(0.6,0.6,'pedestrian'), 'pedestrian.adult_standing':(0.6,0.6,'pedestrian'),
 'pedestrian.child_walking':(0.6,0.6,'pedestrian'), 'pedestrian.child_standing':(0.6,0.6,'pedestrian'),
 'pedestrian.traffic_marshal':(0.6,0.6,'pedestrian'), 'construction.flagger':(0.6,0.6,'pedestrian'),
}
PROPS = ['construction.traffic_cone','construction.channelizer_drum','construction.barricade_type3',
         'construction.jersey_barrier_run','construction.arrow_board','construction.sign_road_work',
         'construction.excavator','construction.spoil_pile','construction.portable_signal',
         'hazard.cardboard_box','hazard.downed_branch','hazard.tire_debris','hazard.trash_bags',
         'occluder.dumpster','occluder.hedge_run','occluder.fence_run','occluder.covered_car',
         'street.bus_shelter','street.food_cart','street.mailbox_cluster','vehicle.suv','vehicle.sedan',
         'vehicle.box_truck','vehicle.bus','vehicle.van','vehicle.pickup']
PROP_DIMS = {'construction.traffic_cone':(0.4,0.4),'construction.channelizer_drum':(0.6,0.6),
             'construction.barricade_type3':(2.4,0.5),'construction.jersey_barrier_run':(6.0,0.6),
             'construction.arrow_board':(2.0,1.2),'construction.sign_road_work':(1.2,0.2),
             'construction.excavator':(6.0,2.6),'construction.spoil_pile':(3.0,2.0),
             'construction.portable_signal':(0.6,0.6),'hazard.cardboard_box':(0.6,0.5),
             'hazard.downed_branch':(2.5,0.8),'hazard.tire_debris':(0.8,0.4),'hazard.trash_bags':(1.0,0.8),
             'occluder.dumpster':(2.0,1.5),'occluder.hedge_run':(8.0,1.0),'occluder.fence_run':(8.0,0.3),
             'occluder.covered_car':(4.6,1.9),'street.bus_shelter':(4.0,1.6),'street.food_cart':(2.0,1.4),
             'street.mailbox_cluster':(1.2,0.6)}

VERBS = ['near_miss_ego','cross_in_front','stop_still','brake_to_stop','hold_course',
         'ignore_right_of_way','cut_in_ahead','follow_lane','reverse_out']


def _cli(args, timeout=1800):
    p = subprocess.run(CLI + list(args), capture_output=True, text=True, timeout=timeout, cwd=REPO)
    out = None
    for line in p.stdout.splitlines():
        line = line.strip()
        if line.startswith('{'):
            try: out = json.loads(line)
            except Exception: pass
    return p.returncode, out, p.stdout[-2000:], p.stderr[-2000:]


class ToolError(Exception):
    def __init__(self, msg, **kw): super().__init__(msg); self.payload = {'error': msg, **kw}


class VisualCanvas:
    """One brief's authoring session."""

    def __init__(self, brief_id, category, brief, outdir, span_m=70, px=900, max_iters=4):
        self.brief_id, self.category, self.brief = brief_id, category, brief
        self.outdir = outdir; os.makedirs(outdir, exist_ok=True)
        self.span, self.px = span_m, px
        self.frames = {}            # lossless visual memory: id -> {'png', 'view'}
        self.actors, self.props, self.acts = [], [], []
        self.requirement = None
        self.site = None; self.route = None
        self.iters = 0; self.max_iters = max_iters
        self.log = []; self.tests = []
        self._site_pool = None; self._pool_i = 0
        self.junction = False; self._site_pool_junction = None

    # ---------- site discovery ----------
    def _probe(self, junction=False, min_lanes=1):
        probe = self._template(probe_only=True, junction=junction, min_lanes=min_lanes)
        p = f"{self.outdir}/probe.template.json"; json.dump(probe, open(p,'w'))
        rc, o, so, se = _cli(["template","validate",p])
        if rc != 0:
            raise ToolError('probe template invalid', issues=[i.get('message','')[:120] for i in (o or {}).get('issues',[])[:4]])
        rc, o, so, se = _cli(["sites","match",p,"--all-maps"])
        pool = []
        for m in (o or {}).get('maps', []):
            for s in (m.get('sites') or [])[:6]:
                pool.append({'map': m['mapId'], 'siteId': s['siteId'], 'entry': s.get('entryLaneRsl'),
                             'score': s.get('score'), 'runwayM': s.get('runwayDownstreamM')})
        pool.sort(key=lambda z: -(z['score'] or 0))
        # interleave maps so successive looks land on different maps
        by = {}
        for s in pool: by.setdefault(s['map'], []).append(s)
        inter, i = [], 0
        while any(by.values()):
            for k in list(by):
                if by[k]: inter.append(by[k].pop(0))
        return inter

    def look(self, junction=False, next_site=True):
        """Render a candidate site top-down, with the ego already seeded, and return the frame."""
        if self._site_pool is None or self._site_pool_junction != junction:
            self._site_pool = self._probe(junction=junction)
            self._site_pool_junction = junction; self.junction = junction; self._pool_i = 0
            if not self._site_pool: raise ToolError('no site matches this corridor', junction=junction)
        if next_site or self.site is None:
            for _ in range(len(self._site_pool)):
                if self._pool_i >= len(self._site_pool): self._pool_i = 0
                cand = self._site_pool[self._pool_i]; self._pool_i += 1
                rt = RT.build_route(DEV, cand['map'], cand['entry'])
                if rt['lengthM'] >= S0 + 30:
                    self.site, self.route = cand, rt; break
            else:
                raise ToolError('no candidate site has a traceable route')
        return self.render(note='candidate site')

    # ---------- rendering (the agent's eye) ----------
    def _ego_speed_kph(self):
        lim = self.route.get('speedLimitKph') or 40
        return max(20.0, min(45.0, 0.75*lim))

    def _ego_s(self):
        return S0 - self._ego_speed_kph()/3.6*APPROACH_S

    def _boxes(self):
        v = self._ego_speed_kph()
        boxes = []
        p = RT.from_logical(self.route, self._ego_s(), 0, 0.0)
        boxes.append({'x':p['x'],'y':p['y'],'headingRad':p['headingRad'],'l':4.8,'w':1.9,
                      'label':f"EGO {v:.0f}kph", 'role':'ego'})
        for a in self.actors:
            p = RT.from_logical(self.route, a['s'], a['laneOffset'], a['tFrac'])
            l, w, _ = CATALOG_DIMS.get(a['catalogId'], (4.5,1.8,'car'))
            boxes.append({'x':p['x'],'y':p['y'],'headingRad':p['headingRad']+a.get('headingOffsetRad',0.0),
                          'l':l,'w':w,'label':f"{a['id']}", 'role':'threat'})
        for pr in self.props:
            l, w = PROP_DIMS.get(pr['catalogId'], (2.0,1.0))
            for k in range(pr.get('count',1)):
                p = RT.from_logical(self.route, pr['s'] + k*pr.get('spacingM',0.0),
                                    pr['laneOffset'], pr['tFrac'])
                boxes.append({'x':p['x'],'y':p['y'],'headingRad':p['headingRad'],'l':l,'w':w,
                              'label': (pr['id'] if k == 0 else ''), 'role':'prop'})
        return boxes

    def _view_center(self):
        return RT.at_s(self.route, (self._ego_s() + S0 + 15.0)/2.0)

    def render(self, note=''):
        c = self._view_center()
        fid = f"f{len(self.frames)}"
        png = f"{self.outdir}/{fid}.png"
        title = (f"{self.site['map']} | site {self.site['siteId'][:8]} | t=0 SPAWN LAYOUT | "
                 f"view {2*self.span} m across, grid 10 m | {note}")
        marks = []
        es = self._ego_s()
        for ds in range(-20, 121, 20):
            s = es + ds
            if 0 <= s <= self.route['lengthM']:
                q = RT.at_s(self.route, s)
                marks.append({'x':q['x'],'y':q['y'],'label':f"{ds:+d}m"})
        viz.draw_scene(DEV, self.site['map'], self.site['entry'], c['x'], c['y'], self.span, self.px,
                       self._boxes(), png, title,
                       ego_pl=[{'x':p[0],'y':p[1]} for p in self.route['pts']], markers=marks)
        view = {'center':(c['x'],c['y']),'span':self.span,'px':self.px}
        self.frames[fid] = {'png':png,'view':view}
        # separation report: the thing a blind agent cannot see (gate C2)
        sep = []
        egop = RT.from_logical(self.route, self._ego_s(), 0, 0.0)
        for a in self.actors:
            p = RT.from_logical(self.route, a['s'], a['laneOffset'], a['tFrac'])
            sep.append({'actor':a['id'],'initialSeparationM':round(math.hypot(p['x']-egop['x'],p['y']-egop['y']),1),
                        'dsFromEgoM':round(a['s']-self._ego_s(),1)})
        return {'frame':fid,'png':png,'map':self.site['map'],'site':self.site['siteId'],
                'speedLimitKph':self.route.get('speedLimitKph'),'routeLengthM':round(self.route['lengthM'],1),
                'egoSpeedKph':round(self._ego_speed_kph(),1),
                'pxPerM': round(self.px/(2.0*self.span),2),
                'egoPixel': self.world_to_px(egop['x'],egop['y']),
                'initialSeparation': sep, 'actors':[a['id'] for a in self.actors],
                'props':[p['id'] for p in self.props], 'acts':[(a['actor'],a['verb']) for a in self.acts]}

    def world_to_px(self, x, y):
        v = self._view_center(); cx, cy = v['x'], v['y']
        px = (x - (cx - self.span))/(2*self.span)*self.px
        py = ((cy + self.span) - y)/(2*self.span)*self.px
        return [round(px), round(py)]

    def px_to_world(self, px_x, px_y):
        c = self._view_center()
        return R.world_from_pixel({'center':(c['x'],c['y']),'span':self.span,'px':self.px}, px_x, px_y)

    def inspect(self, frame, region, upscale=2):
        """VISTA's lossless visual memory: re-open ANY past frame, zoomed."""
        if frame not in self.frames: raise ToolError('no such frame', have=list(self.frames))
        out = f"{self.outdir}/{frame}-zoom{len(self.frames)}.png"
        return viz.zoom(self.frames[frame]['png'], region, out, upscale)

    # ---------- authoring by pointing ----------
    def _project(self, px_x, px_y):
        x, y = self.px_to_world(px_x, px_y)
        pr = RT.project(self.route, x, y)
        if pr is None: raise ToolError('pixel does not project onto the site route')
        lo, tf = RT.to_logical(pr['lateralM'], pr['widthM'])
        if abs(lo) > 3 or abs(pr['lateralM']) > 12.0:
            raise ToolError('that pixel is off the ego corridor — pick a point on the corridor or its '
                            'immediate kerb/verge (the gold line with the +Nm station labels)',
                            lateralOffsetM=pr['lateralM'], laneOffset=lo)
        if pr['s'] < self._ego_s() - 15 or pr['s'] > S0 + 60:
            raise ToolError('that pixel is outside the authorable window along the corridor',
                            sM=pr['s'], egoSM=round(self._ego_s(),1), conflictSM=S0)
        return {'s': pr['s'], 'laneOffset': lo, 'tFrac': tf, 'lateralM': pr['lateralM'],
                'widthM': round(pr['widthM'],2)}

    def place(self, id, catalogId, px, py, facing='with_traffic', speedKph=None):
        if catalogId not in CATALOG_DIMS:
            raise ToolError('unknown actor catalogId', available=sorted(CATALOG_DIMS))
        if any(a['id'] == id for a in self.actors): raise ToolError('duplicate actor id', id=id)
        if facing not in ('with_traffic','oncoming','cross_left','cross_right'):
            raise ToolError('facing must be with_traffic|oncoming|cross_left|cross_right')
        g = self._project(px, py)
        head = {'with_traffic':0.0,'oncoming':math.pi,'cross_left':math.pi/2,'cross_right':-math.pi/2}[facing]
        cls = CATALOG_DIMS[catalogId][2]
        self.actors.append({'id':id,'catalogId':catalogId,'class':cls,'facing':facing,
                            'headingOffsetRad':head,'speedKph':speedKph, **g})
        self.log.append(('place', id, catalogId, [px,py], g['s'], g['laneOffset'], g['tFrac']))
        return {'placed':id,'logical':{'laneOffset':g['laneOffset'],'sM':g['s'],'tFrac':g['tFrac']},
                **self.render(note=f'placed {id}')}

    def move(self, id, px, py):
        a = next((a for a in self.actors if a['id'] == id), None)
        if a is None: raise ToolError('no such actor', have=[x['id'] for x in self.actors])
        a.update(self._project(px, py))
        self.log.append(('move', id, [px,py], a['s']))
        return {'moved':id, **self.render(note=f'moved {id}')}

    def remove(self, id):
        self.actors = [a for a in self.actors if a['id'] != id]
        self.props = [p for p in self.props if p['id'] != id]
        self.acts = [a for a in self.acts if a['actor'] != id]
        return {'removed':id, **self.render(note=f'removed {id}')}

    def prop(self, id, catalogId, px, py, count=1, spacingM=5.0):
        if catalogId not in PROPS: raise ToolError('unknown prop catalogId', available=PROPS)
        if any(p['id'] == id for p in self.props): raise ToolError('duplicate prop id', id=id)
        g = self._project(px, py)
        self.props.append({'id':id,'catalogId':catalogId,'count':int(count),'spacingM':float(spacingM), **g})
        self.log.append(('prop', id, catalogId, [px,py], g['s']))
        return {'placed':id, **self.render(note=f'prop {id}')}

    def act(self, id, verb, clearanceM=1.5, delayS=1.0):
        if verb not in VERBS: raise ToolError('unknown verb', available=VERBS)
        if not any(a['id'] == id for a in self.actors):
            raise ToolError('no such actor', have=[x['id'] for x in self.actors])
        self.acts = [a for a in self.acts if a['actor'] != id]
        self.acts.append({'actor':id,'verb':verb,'clearanceM':float(clearanceM),'delayS':float(delayS)})
        self.log.append(('act', id, verb))
        return {'ok':True,'acts':[(a['actor'],a['verb']) for a in self.acts]}

    def require(self, metric='ttc', band=(0.3, 2.5)):
        if metric not in ('ttc','pet','path_ttc'): raise ToolError('metric must be ttc|pet|path_ttc')
        self.requirement = {'metric':metric,'band':[float(band[0]), float(band[1])]}
        return {'ok':True, 'require':self.requirement}

    # ---------- portable template emission ----------
    def _template(self, probe_only=False, junction=False, min_lanes=1):
        vexpr = EGO_SPEED
        feats = []
        if junction or (not probe_only and self.junction):
            feats = [{'id':'jx','kind':'junction','label':'junction','essentiality':'required',
                      'atM':{'value':[S0-10, S0+10],'essentiality':'required'}}]
        doc = {
          'scenarioVersion':2,
          'meta':{'name':self.brief_id,'description':self.brief[:280],
                  'createdAt':'2026-08-01T00:00:00.000Z','modifiedAt':'2026-08-01T00:00:00.000Z',
                  'appVersion':'simforge/0.0.1','archetype':self.category,
                  'tags':['lane2','vista-visual'],'author':'agent/lane2-visual','negativeControl':False},
          'params':{'declarations':[],'constraints':[]},
          'environment':{'weather':'clear','timeOfDay':'afternoon'},
          'anchor':{'id':self.brief_id,
            'corridor':{
              'throughLanesSameDir':{'value':[min_lanes,8],'essentiality':'required'},
              'speedLimitKph':{'value':[25,80],'essentiality':'preferred','weight':2},
              'curvatureDegPer10m':{'value':[0,20],'essentiality':'required'},
              'runwayDownstreamM':{'value':[180,None],'essentiality':'required'}},
            'features':feats,
            'policy':{'allowMirror':True,'maxSitesPerMap':8,'diversity':'moderate','minScore':0.4}},
          'roles':[{'id':'ego','kind':'on_reference','label':'vehicle under test',
                    'actor':{'class':'car','catalogId':'vehicle.sedan'},'essentiality':'required',
                    'pose':{'laneOffset':0,'s':f'{S0} - ({vexpr})/3.6*{APPROACH_S}','tFrac':0,'headingOffsetRad':0},
                    'initialSpeedKph':vexpr}],
          'props':[],
          'choreography':{'clipSeconds':CLIP,'warmupSeconds':WARMUP,'interactions':[]},
          'invariants':[], 'variants':[], 'metricSubject':'ego'}
        if probe_only: return doc

        params = doc['params']['declarations']
        def addp(pid, rng, dflt, unit):
            if not any(d['id']==pid for d in params):
                params.append({'id':pid,'type':'continuous','description':pid,'unit':unit,'tier':1,
                               'range':list(rng),'default':dflt,'distribution':'uniform'})

        acts = {a['actor']: a for a in self.acts}
        threat = None
        for a in self.actors:
            v = acts.get(a['id'], {}).get('verb')
            if v in ('near_miss_ego','cross_in_front','cut_in_ahead','reverse_out'): threat = a['id']
        if threat is None and self.actors: threat = self.actors[0]['id']

        for a in self.actors:
            v = acts.get(a['id'], {}).get('verb')
            if a['class'] == 'pedestrian':
                addp('vruSpeedKph', [3.0, 8.5], 5.0, 'kph'); spd = 'param.vruSpeedKph'
            elif a['class'] == 'bicycle':
                addp('vruSpeedKph', [10.0, 20.0], 15.0, 'kph'); spd = 'param.vruSpeedKph'
            else:
                spd = 'clamp(0.85 * lane.speedLimitKph, 20, 55)'
            if v == 'stop_still' or a.get('speedKph') == 0: spd = 0
            role = {'id':a['id'],'kind':'on_reference','label':f"{a['id']} ({a['catalogId']})",
                    'actor':{'class':a['class'],'catalogId':a['catalogId']},'essentiality':'required',
                    'pose':{'laneOffset':a['laneOffset'],'s':round(a['s'],2),'tFrac':a['tFrac'],
                            'headingOffsetRad':round(a['headingOffsetRad'],4)},
                    'initialSpeedKph':spd}
            doc['roles'].append(role)

        for pr in self.props:
            p = {'id':pr['id'],'catalogId':pr['catalogId'],'label':pr['catalogId'],'essentiality':'required',
                 'pose':{'laneOffset':pr['laneOffset'],'s':round(pr['s'],2),'tFrac':pr['tFrac'],'headingOffsetRad':0},
                 'headingOffsetRad':0,'scale':1}
            if pr['count'] > 1: p['repeat'] = {'count':pr['count'],'spacingM':pr['spacingM'],'tFracStep':0}
            doc['props'].append(p)

        I = doc['choreography']['interactions']
        for k, a in enumerate(self.acts):
            aid, v = a['actor'], a['verb']
            act_obj = next((x for x in self.actors if x['id']==aid), None)
            if act_obj is None: continue
            iid = f"i{k}-{aid}-{v}"
            if v in ('near_miss_ego','cross_in_front'):
                addp('clearanceM', [0.6, 3.0], a['clearanceM'], 'm')
                I.append({'id':iid,'actor':aid,'label':'engine-solved near miss with the ego',
                          'verb':'route','trigger':{'kind':'at','t':0},
                          'target':{'mode':'nearMiss','target':'ego','clearanceM':'param.clearanceM',
                                    'pass':'front' if v=='cross_in_front' else 'auto',
                                    'deadlineS': CLIP-2.0}})
                I.append({'id':iid+'-nca','actor':aid,'verb':'set','trigger':{'kind':'at','t':0},
                          'target':{'key':'rules.collisionAvoidance','value':False}})
            elif v == 'brake_to_stop':
                I.append({'id':iid,'actor':aid,'verb':'speed',
                          'trigger':{'kind':'when','byLatest':CLIP-5.0,'ifNever':'fire',
                                     'condition':{'kind':'headway','of':'ego','to':aid,'op':'lte','valueS':2.5}},
                          'target':{'mode':'stop'},'dynamics':{'shape':'linear','constraint':'rate','value':7.0}})
            elif v == 'cut_in_ahead':
                I.append({'id':iid,'actor':aid,'verb':'changeLane',
                          'trigger':{'kind':'when','byLatest':CLIP-5.0,'ifNever':'fire',
                                     'condition':{'kind':'distance','from':'ego','to':{'role':aid},
                                                  'measure':'euclidean','op':'lte','valueM':28}},
                          'target':{'mode':'toRole','role':'ego'},
                          'dynamics':{'shape':'sinusoidal','constraint':'rate','value':1.4}})
            elif v == 'ignore_right_of_way':
                I.append({'id':iid,'actor':aid,'verb':'set','trigger':{'kind':'at','t':0},
                          'target':{'key':'rules.yieldToVehicles','value':False}})
            elif v == 'hold_course':
                I.append({'id':iid,'actor':aid,'verb':'set','trigger':{'kind':'at','t':0},
                          'target':{'key':'rules.collisionAvoidance','value':False}})
            elif v == 'stop_still':
                I.append({'id':iid,'actor':aid,'verb':'speed','trigger':{'kind':'at','t':0},
                          'target':{'mode':'absolute','valueKph':0},
                          'dynamics':{'shape':'step','constraint':'time','value':0.1}})
            elif v == 'reverse_out':
                I.append({'id':iid,'actor':aid,'verb':'speed','trigger':{'kind':'at','t':0},
                          'target':{'mode':'absolute','valueKph':6},
                          'dynamics':{'shape':'linear','constraint':'time','value':1.5}})
            # follow_lane: no interaction needed

        inv = doc['invariants']
        if threat:
            inv.append({'id':'no-contact','kind':'near_miss','essentiality':'required',
                        'label':'true footprint clearance, gate C3',
                        'pedestrian':threat,'target':'ego','clearanceRangeM':[0.3, 5.0]})
        rq = self.requirement or {'metric':'ttc','band':[0.3, 2.8]}
        if threat:
            inv.append({'id':'criticality','kind':rq['metric'],'essentiality':'required',
                        'of':'ego','to':threat,'range':rq['band'],'window':[WARMUP+0.5, CLIP-1.0]})
        inv.append({'id':'ego-decel-budget','kind':'decel_budget','essentiality':'preferred',
                    'of':'ego','maxMps2':7.5})
        return doc

    def template_path(self):
        doc = self._template()
        p = f"{self.outdir}/{self.brief_id}.template.json"
        json.dump(doc, open(p,'w'), indent=1)
        return p, doc

    # ---------- the feedback loop ----------
    def test(self, draws=4, all_maps=True):
        if not self.actors: raise ToolError('place at least one actor before testing')
        self.iters += 1
        t0 = time.time()
        p, doc = self.template_path()
        rc, o, so, se = _cli(["template","validate",p])
        if rc != 0:
            return {'stage':'validate','ok':False,
                    'issues':[{'path':i.get('path'),'reason':i.get('message','')[:160]} for i in (o or {}).get('issues',[])[:6]]}
        rc, o, so, se = _cli(["sites","match",p,"--all-maps"])
        nsites = (o or {}).get('totalSites', 0)
        if not nsites:
            return {'stage':'sites','ok':False,'sites':0,'why':'no map site satisfies this anchor'}
        out = f"{self.outdir}/run{self.iters}"
        shutil.rmtree(out, ignore_errors=True)
        rc, o, so, se = _cli(["batch",p,"--all-maps","--draws",str(draws),"--out",out], timeout=3600)
        summ = f"{out}/batch-summary.json"
        if not os.path.exists(summ):
            return {'stage':'batch','ok':False,'stderr':se[-400:]}
        g = G.gate_batch(summ, WARMUP)
        S = json.load(open(summ))
        # why cells failed, in gate terms
        fail = {'C5_verdict':0,'C1_ego_static':0,'C2_spawn_artifact':0,'C3_too_far':0,'C4_no_demand':0}
        for c in g['cells']:
            if c.get('ok'): continue
            if not c.get('C5'): fail['C5_verdict'] += 1
            elif not c.get('C1'): fail['C1_ego_static'] += 1
            elif not c.get('C3'): fail['C3_too_far'] += 1
            elif not c.get('C2'): fail['C2_spawn_artifact'] += 1
            else: fail['C4_no_demand'] += 1
        strip = None
        best = None
        for c in g['cells']:
            if c.get('trace') and os.path.exists(c['trace']):
                if best is None or (c.get('ok') and not best.get('ok')): best = c
                if c.get('ok'): break
        if best:
            try:
                strip = f"{self.outdir}/strip{self.iters}.png"
                viz.filmstrip(DEV, best['trace'], strip)
            except Exception as e:
                strip = None
        res = {'stage':'gate','ok':True,'iteration':self.iters,'sitesMatched':nsites,
               'cells':len(g['cells']),'qualifying':g['qualifying'],'maps':g['maps'],
               'distinctSites':g['sites'],'admitted':g['admitted'],'failureCensus':fail,
               'bands':(S.get('criticality') or {}).get('bands'),
               'sampleCells':[{k:c.get(k) for k in ('map','C1','C2','C3','C4','C5','obbClearanceM','tClosest',
                                                    'requiredDecelMaxEgo','minTTC')} for c in g['cells'][:6]],
               'filmstrip':strip,'elapsedS':round(time.time()-t0,1),
               'traces':g['traces'],'summary':summ,'template':p}
        if strip:
            fid = f"strip{self.iters}"
            self.frames[fid] = {'png':strip,'view':None}
            res['filmstripFrame'] = fid
        self.tests.append({k:res.get(k) for k in ('iteration','qualifying','maps','distinctSites','admitted','failureCensus')})
        return res
