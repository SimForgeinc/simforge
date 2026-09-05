/**
 * Authored incident taxonomy used by the SimForge installed-map catalog.
 *
 * These are functional incident descriptions, not concrete-test parameter
 * samples. A catalog slot binds one incident to a real, digest-pinned map
 * location and an operational variant. Simulation/rendering are later gates.
 */

export const INCIDENT_DOMAINS = [
  'intersection',
  'vulnerable-road-user',
  'longitudinal',
  'lane-change-and-merge',
  'parking-and-access',
  'transit',
  'work-and-school-zone',
  'road-departure-and-obstacle',
] as const;

export type IncidentDomain = (typeof INCIDENT_DOMAINS)[number];

export interface CatalogResearchSource {
  readonly id: string;
  readonly title: string;
  readonly publisher: string;
  readonly publication: string;
  readonly url: string;
  readonly scope: string;
}

export const CATALOG_RESEARCH_SOURCES: readonly CatalogResearchSource[] = [
  {
    id: 'nhtsa-precrash-2007',
    title: 'Pre-Crash Scenario Typology for Crash Avoidance Research',
    publisher: 'National Highway Traffic Safety Administration',
    publication: 'DOT HS 810 767 (2007)',
    url: 'https://rosap.ntl.bts.gov/view/dot/6281',
    scope: 'Rear-end, road-departure, lane-change, crossing-path, opposite-direction, backing, pedestrian, pedalcyclist, animal, and object pre-crash groups.',
  },
  {
    id: 'nhtsa-precrash-2019',
    title: 'Statistics of Light-Vehicle Pre-Crash Scenarios Based on 2011–2015 National Crash Data',
    publisher: 'National Highway Traffic Safety Administration',
    publication: 'DOT HS 812 745 (2019)',
    url: 'https://rosap.ntl.bts.gov/view/dot/41932',
    scope: 'Thirty-six nationally grounded light-vehicle pre-crash scenarios and their road, environment, and avoidance characteristics.',
  },
  {
    id: 'nhtsa-v2v-kinematics-2013',
    title: 'Description of Light-Vehicle Pre-Crash Scenarios for Safety Applications Based on Vehicle-to-Vehicle Communications',
    publisher: 'National Highway Traffic Safety Administration',
    publication: 'DOT-VNTSC-NHTSA-11-11 (2013)',
    url: 'https://rosap.ntl.bts.gov/view/dot/9980',
    scope: 'Five-second pre-crash speed, braking, and deceleration kinematics for priority vehicle-to-vehicle conflicts.',
  },
  {
    id: 'euroncap-aeb-vru',
    title: 'AEB Pedestrian test scenarios',
    publisher: 'Euro NCAP',
    publication: 'VRU Protection protocols (2026)',
    url: 'https://www.euroncap.com/en/car-safety/the-ratings-explained/vulnerable-road-user-vru-protection/aeb-pedestrian/',
    scope: 'Adult and child crossing, parked-car occlusion, longitudinal pedestrian, turning pedestrian, reversing, daylight, and low-light cases.',
  },
] as const;

export interface IncidentActorRole {
  readonly role: string;
  readonly kind: 'vehicle' | 'pedestrian' | 'cyclist' | 'object';
  readonly intent: string;
}

export interface IncidentDefinition {
  readonly id: string;
  readonly title: string;
  readonly domain: IncidentDomain;
  readonly summary: string;
  readonly siteTypes: readonly string[];
  readonly requiredAffordances?: readonly string[];
  readonly preferredTags?: readonly string[];
  readonly mapIds?: readonly string[];
  readonly actors: readonly IncidentActorRole[];
  readonly eventSequence: readonly string[];
  readonly criticality: readonly string[];
  readonly sourceIds: readonly string[];
  /** Existing executable template, when this functional scenario is implemented today. */
  readonly implementationTemplateId?: string;
}

const ego: IncidentActorRole = {
  role: 'ego', kind: 'vehicle', intent: 'Proceed legally while retaining a physically plausible avoidance opportunity.',
};

function other(role: string, kind: IncidentActorRole['kind'], intent: string): IncidentActorRole {
  return { role, kind, intent };
}

const vehicleSources = ['nhtsa-precrash-2007', 'nhtsa-precrash-2019', 'nhtsa-v2v-kinematics-2013'] as const;
const vruSources = ['nhtsa-precrash-2007', 'nhtsa-precrash-2019', 'euroncap-aeb-vru'] as const;

/**
 * Broad enough that every map receives many distinct incident mechanisms.
 * Map applicability is resolved against the actual location catalog, never by
 * assuming that a feature (school, bus stop, work zone) exists everywhere.
 */
export const INCIDENT_TAXONOMY: readonly IncidentDefinition[] = [
  {
    id: 'intersection.left-turn-across-opposing-through', title: 'Unprotected left across opposing through vehicle', domain: 'intersection',
    summary: 'A turning vehicle accepts a narrowing gap across an oncoming through path.',
    siteTypes: ['junction_movement'], requiredAffordances: ['vehicleSpawn', 'route'], preferredTags: ['TURN_LEFT', 'UNPROTECTED_LEFT'],
    actors: [ego, other('opposing', 'vehicle', 'Maintain through movement into the shared conflict zone.')],
    eventSequence: ['Ego approaches the junction.', 'Ego initiates an unprotected left.', 'Opposing vehicle reaches the conflict zone inside the critical gap.'],
    criticality: ['time-to-collision at conflict entry', 'accepted-gap duration', 'braking response'], sourceIds: vehicleSources,
    implementationTemplateId: 'ltap-opposing',
  },
  {
    id: 'intersection.cross-traffic-stop-violation', title: 'Cross traffic rolls through a stop-controlled approach', domain: 'intersection',
    summary: 'A cross-traffic vehicle fails to yield and enters as ego traverses the junction.',
    siteTypes: ['junction', 'junction_movement'], requiredAffordances: ['conflictPoint'], preferredTags: ['CONTROL_MINOR_STOP', 'CONTROL_UNCONTROLLED'],
    actors: [ego, other('violator', 'vehicle', 'Enter from the crossing arm without completing the required stop.')],
    eventSequence: ['Ego enters with priority.', 'Cross traffic rolls past its control point.', 'Paths overlap in the junction conflict zone.'],
    criticality: ['lateral time-to-collision', 'stop-line violation speed', 'junction occupancy'], sourceIds: vehicleSources,
    implementationTemplateId: 'intersection.cross-traffic-stop-violation',
  },
  {
    id: 'intersection.red-light-late-entry', title: 'Late red-light entry against released traffic', domain: 'intersection',
    summary: 'One vehicle enters at the end of its phase after the conflicting movement has started.',
    siteTypes: ['junction', 'junction_movement'], preferredTags: ['CONTROL_SIGNALIZED'],
    actors: [ego, other('late-entry', 'vehicle', 'Continue into the junction after the permissive phase ends.')],
    eventSequence: ['Conflicting phase releases ego.', 'Late vehicle crosses its stop line.', 'Both movements occupy the conflict zone.'],
    criticality: ['signal phase relation', 'stop-line crossing time', 'lateral clearance'], sourceIds: vehicleSources,
    implementationTemplateId: 'intersection.red-light-late-entry',
  },
  {
    id: 'intersection.right-turn-crosswalk', title: 'Right turn across an occupied crosswalk', domain: 'intersection',
    summary: 'A turning vehicle must yield to a pedestrian already entering the receiving-road crosswalk.',
    siteTypes: ['crosswalk', 'junction_movement'], requiredAffordances: ['crossing'], preferredTags: ['TURN_RIGHT'],
    actors: [ego, other('pedestrian', 'pedestrian', 'Cross at a steady walking pace with priority.')],
    eventSequence: ['Pedestrian enters the crosswalk.', 'Ego begins the right turn.', 'Ego path crosses the pedestrian trajectory.'],
    criticality: ['pedestrian lateral offset', 'turn speed', 'yield-point stopping margin'], sourceIds: vruSources,
    implementationTemplateId: 'intersection.right-turn-crosswalk',
  },
  {
    id: 'intersection.left-turn-crosswalk', title: 'Left turn across a far-side pedestrian crossing', domain: 'intersection',
    summary: 'Ego focuses on opposing traffic and encounters a pedestrian in the far-side crosswalk.',
    siteTypes: ['crosswalk', 'junction_movement'], requiredAffordances: ['crossing'], preferredTags: ['TURN_LEFT'],
    actors: [ego, other('pedestrian', 'pedestrian', 'Cross the receiving road while ego completes its turn.')],
    eventSequence: ['Ego waits for opposing traffic.', 'Pedestrian enters the far crosswalk.', 'Ego accelerates into the pedestrian path.'],
    criticality: ['attention-switch timing', 'turn acceleration', 'post-conflict stopping margin'], sourceIds: vruSources,
    implementationTemplateId: 'intersection.left-turn-crosswalk',
  },
  {
    id: 'intersection.opposing-turn-encroachment', title: 'Opposing turn encroaches into ego lane', domain: 'intersection',
    summary: 'An opposing vehicle cuts the turn and partially occupies ego’s receiving lane.',
    siteTypes: ['junction_movement'], requiredAffordances: ['route', 'vehicleSpawn'], preferredTags: ['TURN_LEFT', 'TURN_RIGHT'],
    actors: [ego, other('encroaching-turner', 'vehicle', 'Take an apex that crosses the lane boundary.')],
    eventSequence: ['Both vehicles approach.', 'Other vehicle turns with excessive path cut.', 'Ego must brake or move laterally to preserve clearance.'],
    criticality: ['minimum lateral clearance', 'closing speed', 'available escape width'], sourceIds: vehicleSources,
    implementationTemplateId: 'intersection.opposing-turn-encroachment',
  },
  {
    id: 'intersection-blocked-box-reveal', title: 'Blocked junction hides crossing traffic', domain: 'intersection',
    summary: 'A queued vehicle masks cross traffic until ego noses into an obstructed junction.',
    siteTypes: ['junction', 'junction_movement'], preferredTags: ['ARMS_3', 'ARMS_4'],
    actors: [ego, other('occluding-queue', 'vehicle', 'Remain stopped and block the sight line.'), other('cross-traffic', 'vehicle', 'Traverse behind the queue at legal speed.')],
    eventSequence: ['Queue stops near the junction.', 'Ego creeps past the occluder.', 'Cross traffic is revealed at short range.'],
    criticality: ['occlusion duration', 'creep speed', 'reveal time-to-collision'], sourceIds: vehicleSources,
    implementationTemplateId: 'intersection-blocked-box-reveal',
  },
  {
    id: 'vru.child-dartout-parked-cars', title: 'Child darts from between parked vehicles', domain: 'vulnerable-road-user',
    summary: 'A child emerges laterally from complete vehicle occlusion into ego’s lane.',
    siteTypes: ['occlusion_zone', 'parking_lane'], requiredAffordances: ['occluder', 'pedestrianSpawn'], preferredTags: ['PEDESTRIAN_DARTOUT', 'OCCLUSION_PARKING_VRU'],
    actors: [ego, other('child', 'pedestrian', 'Run from the curb gap into the travel lane.'), other('parked-occluder', 'vehicle', 'Remain static and fully mask the child before reveal.')],
    eventSequence: ['Child waits behind parked vehicles.', 'Ego approaches with no line of sight.', 'Child runs into the lane at the reveal threshold.'],
    criticality: ['first-visible distance', 'child running speed', 'impact-speed mitigation'], sourceIds: vruSources,
    implementationTemplateId: 'cpnco-parked-row',
  },
  {
    id: 'vru.adult-midblock-crossing', title: 'Adult crosses at an unmarked midblock location', domain: 'vulnerable-road-user',
    summary: 'An adult walks across a corridor away from a controlled crossing.',
    siteTypes: ['midblock_segment', 'building_entrance'], requiredAffordances: ['pedestrianSpawn'], preferredTags: ['MIDBLOCK'],
    actors: [ego, other('pedestrian', 'pedestrian', 'Walk continuously from curb to curb.')],
    eventSequence: ['Pedestrian approaches the curb.', 'Pedestrian commits to the crossing.', 'Ego reaches the shared lane segment.'],
    criticality: ['pedestrian walking speed', 'crossing offset', 'braking onset'], sourceIds: vruSources,
    implementationTemplateId: 'vru.adult-midblock-crossing',
  },
  {
    id: 'vru.multiple-threat-crosswalk', title: 'Stopped vehicle masks a pedestrian in the next lane', domain: 'vulnerable-road-user',
    summary: 'One vehicle yields at a crossing while an adjacent-lane ego cannot initially see the pedestrian.',
    siteTypes: ['crosswalk'], requiredAffordances: ['crossing'],
    actors: [ego, other('yielding-vehicle', 'vehicle', 'Stop before the crosswalk and create an occlusion.'), other('pedestrian', 'pedestrian', 'Continue across the hidden adjacent lane.')],
    eventSequence: ['Lead vehicle yields.', 'Ego approaches in the adjacent lane.', 'Pedestrian emerges from behind the stopped vehicle.'],
    criticality: ['occluder placement', 'pedestrian reveal distance', 'ego pass speed'], sourceIds: vruSources,
    implementationTemplateId: 'multiple-threat',
  },
  {
    id: 'vru.reversing-pedestrian', title: 'Reversing vehicle crosses a pedestrian path', domain: 'vulnerable-road-user',
    summary: 'A vehicle backs from a parking position while a pedestrian passes behind it.',
    siteTypes: ['parking_space', 'parking_area', 'building_entrance'], requiredAffordances: ['pedestrianSpawn'],
    actors: [ego, other('pedestrian', 'pedestrian', 'Walk behind the reversing path without an abrupt change of pace.')],
    eventSequence: ['Pedestrian enters the rear blind zone.', 'Ego begins reversing.', 'Rear path and walking path overlap.'],
    criticality: ['rear visibility', 'reverse speed', 'pedestrian time in blind zone'], sourceIds: vruSources,
    implementationTemplateId: 'vru.reversing-pedestrian',
  },
  {
    id: 'vru.cyclist-right-hook', title: 'Right hook across a parallel cyclist', domain: 'vulnerable-road-user',
    summary: 'A right-turning vehicle crosses a cyclist continuing straight on its right.',
    siteTypes: ['driving_corridor', 'junction_movement'], requiredAffordances: ['route', 'vehicleSpawn'], preferredTags: ['TURN_RIGHT'],
    actors: [ego, other('cyclist', 'cyclist', 'Continue straight alongside ego at cycling speed.')],
    eventSequence: ['Cyclist and ego travel parallel.', 'Ego begins a right turn.', 'Cyclist enters the turning path.'],
    criticality: ['longitudinal overlap', 'turn onset', 'cyclist closing speed'], sourceIds: vruSources,
    implementationTemplateId: 'vru.cyclist-right-hook',
  },
  {
    id: 'vru.cyclist-crossing-path', title: 'Cyclist crosses the vehicle path', domain: 'vulnerable-road-user',
    summary: 'A cyclist enters from a side path or crossing with a short lateral arrival gap.',
    siteTypes: ['crosswalk', 'junction_movement', 'driving_corridor'], requiredAffordances: ['cyclistSpawn'],
    actors: [ego, other('cyclist', 'cyclist', 'Ride across the vehicle path without stopping in-lane.')],
    eventSequence: ['Ego approaches steadily.', 'Cyclist enters from the side.', 'Trajectories coincide at the conflict point.'],
    criticality: ['cyclist lateral speed', 'arrival-time offset', 'visibility range'], sourceIds: vruSources,
    implementationTemplateId: 'vru.cyclist-crossing-path',
  },
  {
    id: 'vru.dooring-cyclist', title: 'Parked-car door opens into cyclist path', domain: 'vulnerable-road-user',
    summary: 'A parked occupant opens a door as a cyclist passes in the door zone.',
    siteTypes: ['parking_lane', 'parking_space'], requiredAffordances: ['parkedVehicle'], preferredTags: ['PARKING_PARALLEL'],
    actors: [ego, other('cyclist', 'cyclist', 'Ride parallel through the door zone.'), other('door', 'object', 'Swing from closed to open after the cyclist commits.')],
    eventSequence: ['Cyclist approaches the parked row.', 'Door begins opening.', 'Cyclist must brake or merge around the door.'],
    criticality: ['door opening time', 'cyclist lateral clearance', 'adjacent traffic escape gap'], sourceIds: vruSources,
    implementationTemplateId: 'vru.dooring-cyclist',
  },
  {
    id: 'longitudinal.lead-hard-brake', title: 'Lead vehicle brakes sharply in flowing traffic', domain: 'longitudinal',
    summary: 'A lead vehicle performs a plausible emergency stop from cruising speed.',
    siteTypes: ['midblock_segment', 'driving_corridor'], requiredAffordances: ['route', 'vehicleSpawn'],
    actors: [ego, other('lead', 'vehicle', 'Brake hard but within dry-road passenger-car capability.')],
    eventSequence: ['Vehicles travel at a stable headway.', 'Lead vehicle brakes abruptly.', 'Ego must respond before minimum separation is exhausted.'],
    criticality: ['initial headway', 'lead deceleration', 'reaction delay'], sourceIds: vehicleSources,
    implementationTemplateId: 'longitudinal.lead-hard-brake',
  },
  {
    id: 'longitudinal.queue-tail', title: 'Stopped queue tail beyond a sight restriction', domain: 'longitudinal',
    summary: 'Ego encounters the end of a stopped queue with limited preview distance.',
    siteTypes: ['midblock_segment', 'driving_corridor', 'occlusion_zone'], requiredAffordances: ['vehicleSpawn'],
    actors: [ego, other('queue-tail', 'vehicle', 'Remain stopped in lane.'), other('queue-lead', 'vehicle', 'Remain stopped ahead to establish a credible queue.')],
    eventSequence: ['Queue forms downstream.', 'Ego enters the constrained sight segment.', 'Stopped tail becomes visible within the braking envelope.'],
    criticality: ['available sight distance', 'approach speed', 'queue spacing'], sourceIds: vehicleSources,
    implementationTemplateId: 'longitudinal.queue-tail',
  },
  {
    id: 'longitudinal.cutout-reveals-stopped', title: 'Lead vehicle cuts out and reveals a stopped vehicle', domain: 'longitudinal',
    summary: 'A lead vehicle changes lanes late, exposing a stationary obstruction directly ahead.',
    siteTypes: ['midblock_segment', 'driving_corridor'], requiredAffordances: ['route', 'vehicleSpawn'], preferredTags: ['MULTILANE'],
    actors: [ego, other('lead-cutout', 'vehicle', 'Change lanes late while preserving clearance.'), other('stopped', 'vehicle', 'Remain stationary in ego lane.')],
    eventSequence: ['Ego follows the lead vehicle.', 'Lead moves aside near the obstruction.', 'Stopped vehicle is revealed at a short but nonzero stopping margin.'],
    criticality: ['reveal distance', 'lane-change duration', 'ego braking capacity'], sourceIds: vehicleSources,
    implementationTemplateId: 'longitudinal.cutout-reveals-stopped',
  },
  {
    id: 'longitudinal.cut-in-brake', title: 'Close cut-in followed by braking', domain: 'longitudinal',
    summary: 'Another vehicle enters ego’s lane at low headway and immediately decelerates.',
    siteTypes: ['midblock_segment', 'driving_corridor'], requiredAffordances: ['route', 'vehicleSpawn'], preferredTags: ['MULTILANE', 'unsafe_cut_in_prone'],
    actors: [ego, other('cut-in', 'vehicle', 'Merge into the accepted gap, then brake for downstream traffic.')],
    eventSequence: ['Vehicles travel in adjacent lanes.', 'Other vehicle merges ahead of ego.', 'Other vehicle brakes before headway recovers.'],
    criticality: ['post-merge headway', 'lateral insertion rate', 'cut-in deceleration'], sourceIds: vehicleSources,
    implementationTemplateId: 'longitudinal.cut-in-brake',
  },
  {
    id: 'longitudinal.slow-vulnerable-lead', title: 'Slow cyclist or mobility user ahead', domain: 'longitudinal',
    summary: 'Ego closes on a much slower vulnerable road user sharing the lane.',
    siteTypes: ['midblock_segment', 'driving_corridor'], requiredAffordances: ['route'],
    actors: [ego, other('slow-road-user', 'cyclist', 'Proceed steadily near the lane edge with small natural lateral variation.')],
    eventSequence: ['Ego enters behind the slower user.', 'Closing gap becomes apparent.', 'Oncoming or adjacent traffic constrains passing.'],
    criticality: ['closing speed', 'minimum following distance', 'passing clearance'], sourceIds: [...vehicleSources, 'euroncap-aeb-vru'],
    implementationTemplateId: 'longitudinal.slow-vulnerable-lead',
  },
  {
    id: 'lane-change.sideswipe', title: 'Adjacent vehicle drifts into occupied lane', domain: 'lane-change-and-merge',
    summary: 'A parallel vehicle crosses the lane boundary while ego occupies its blind spot.',
    siteTypes: ['driving_corridor', 'midblock_segment', 'parking_lane'], requiredAffordances: ['vehicleSpawn'], preferredTags: ['MULTILANE', 'sideswipe_prone'],
    actors: [ego, other('drifting-vehicle', 'vehicle', 'Move laterally into ego lane without adequate clearance.')],
    eventSequence: ['Vehicles run parallel.', 'Other vehicle begins an unsignalled drift.', 'Side envelopes overlap unless ego yields.'],
    criticality: ['lateral velocity', 'longitudinal overlap', 'escape-lane availability'], sourceIds: vehicleSources,
    implementationTemplateId: 'lane-change.sideswipe',
  },
  {
    id: 'lane-change.merge-gap-collapse', title: 'Merge gap collapses under acceleration', domain: 'lane-change-and-merge',
    summary: 'A merging vehicle and ego both accelerate toward the same diminishing gap.',
    siteTypes: ['driving_corridor', 'midblock_segment', 'junction_movement'], requiredAffordances: ['route', 'vehicleSpawn'], preferredTags: ['MERGE', 'unsafe_cut_in_prone'],
    actors: [ego, other('merging', 'vehicle', 'Accelerate from the entry lane toward ego’s gap.')],
    eventSequence: ['Merging path converges.', 'Both vehicles increase speed.', 'Accepted gap falls below safe headway.'],
    criticality: ['merge-end distance', 'relative acceleration', 'gap at lane crossing'], sourceIds: vehicleSources,
    implementationTemplateId: 'lane-change.merge-gap-collapse',
  },
  {
    id: 'lane-change.lane-drop-late-merge', title: 'Late merge at a lane drop', domain: 'lane-change-and-merge',
    summary: 'A vehicle reaches the end of a disappearing lane and forces entry into ego’s lane.',
    siteTypes: ['driving_corridor', 'midblock_segment'], requiredAffordances: ['route'], preferredTags: ['LANE_DROP', 'MULTILANE'],
    actors: [ego, other('late-merger', 'vehicle', 'Continue to the taper and merge with limited remaining pavement.')],
    eventSequence: ['Lane begins narrowing.', 'Late merger stays alongside ego.', 'Vehicle crosses the boundary near the lane end.'],
    criticality: ['distance to lane end', 'overlap at merge', 'available shoulder'], sourceIds: vehicleSources,
    implementationTemplateId: 'lane-change.lane-drop-late-merge',
  },
  {
    id: 'lane-change.oncoming-overtake', title: 'Oncoming vehicle overtakes into ego lane', domain: 'lane-change-and-merge',
    summary: 'An opposing vehicle uses ego’s lane to pass and must return before closing distance expires.',
    siteTypes: ['midblock_segment', 'driving_corridor'], requiredAffordances: ['route', 'vehicleSpawn'],
    actors: [ego, other('overtaker', 'vehicle', 'Pass a slow vehicle by entering the opposing lane.'), other('slow-vehicle', 'vehicle', 'Maintain a steady low speed.')],
    eventSequence: ['Overtaker moves across centerline.', 'Ego appears in the opposing path.', 'Overtaker attempts to return behind or ahead of the slow vehicle.'],
    criticality: ['closing speed', 'return gap', 'centerline occupancy duration'], sourceIds: vehicleSources,
    implementationTemplateId: 'lane-change.oncoming-overtake',
  },
  {
    id: 'parking.vehicle-pulls-out', title: 'Parked vehicle pulls into the travel lane', domain: 'parking-and-access',
    summary: 'A parked vehicle begins moving from curb or bay into ego’s lane.',
    siteTypes: ['parking_space', 'parking_lane', 'parking_area'], requiredAffordances: ['parkedVehicle', 'vehicleSpawn'],
    actors: [ego, other('departing-vehicle', 'vehicle', 'Pull out with initially restricted visibility.')],
    eventSequence: ['Vehicle waits in the parking position.', 'Front end enters the travel lane.', 'Ego arrives before the vehicle completes its merge.'],
    criticality: ['pullout speed', 'initial visibility', 'lane blockage duration'], sourceIds: vehicleSources,
    implementationTemplateId: 'parking.vehicle-pulls-out',
  },
  {
    id: 'parking.backing-out-vehicle', title: 'Vehicle backs from an angled space into traffic', domain: 'parking-and-access',
    summary: 'A reversing vehicle emerges from a bay with limited sight of approaching traffic.',
    siteTypes: ['parking_space', 'parking_area'], requiredAffordances: ['parkedVehicle', 'vehicleSpawn'], preferredTags: ['PARKING_ANGLED'],
    actors: [ego, other('backing-vehicle', 'vehicle', 'Reverse from the bay across the travel aisle.')],
    eventSequence: ['Ego approaches the parking aisle.', 'Other vehicle begins reversing.', 'Its rear crosses into ego’s path.'],
    criticality: ['reverse speed', 'rear emergence time', 'aisle clearance'], sourceIds: vehicleSources,
    implementationTemplateId: 'parking.backing-out-vehicle',
  },
  {
    id: 'parking.delivery-double-park', title: 'Double-parked delivery vehicle forces a merge', domain: 'parking-and-access',
    summary: 'A stopped delivery vehicle blocks the lane and hides activity near the curb.',
    siteTypes: ['parking_lane', 'midblock_segment', 'parking_area'], requiredAffordances: ['propPlacement'],
    actors: [ego, other('delivery-vehicle', 'vehicle', 'Remain stopped partially in lane.'), other('delivery-worker', 'pedestrian', 'Move between curb and vehicle while occluded.')],
    eventSequence: ['Delivery vehicle blocks part of lane.', 'Ego begins passing.', 'Worker or oncoming traffic constrains the pass.'],
    criticality: ['blocked-lane fraction', 'passing clearance', 'worker reveal distance'], sourceIds: [...vehicleSources, 'euroncap-aeb-vru'],
    implementationTemplateId: 'parking.delivery-double-park',
  },
  {
    id: 'parking.driveway-emergence', title: 'Vehicle emerges from a driveway or access point', domain: 'parking-and-access',
    summary: 'A vehicle crosses sidewalk and enters the road from a visually constrained access.',
    siteTypes: ['building_entrance', 'parking_area', 'junction_movement'], requiredAffordances: ['vehicleSpawn'],
    actors: [ego, other('emerging-vehicle', 'vehicle', 'Creep from access, then accelerate into traffic.')],
    eventSequence: ['Ego approaches the frontage.', 'Other vehicle noses past the sight obstruction.', 'Other vehicle enters the travel lane.'],
    criticality: ['creep distance', 'sight triangle', 'acceleration into lane'], sourceIds: vehicleSources,
    implementationTemplateId: 'parking.driveway-emergence',
  },
  {
    id: 'transit.bus-stop-emergence', title: 'Pedestrian emerges from behind a stopped bus', domain: 'transit',
    summary: 'A bus masks a pedestrian who enters the roadway near the stop.',
    siteTypes: ['bus_stop'], requiredAffordances: ['stopPoint'],
    actors: [ego, other('stopped-bus', 'vehicle', 'Remain at the stop and create the primary occlusion.'), other('pedestrian', 'pedestrian', 'Cross from the hidden side of the bus.')],
    eventSequence: ['Bus stops for passengers.', 'Ego approaches the bus.', 'Pedestrian emerges beyond the bus body.'],
    criticality: ['bus occlusion geometry', 'pedestrian reveal time', 'ego pass speed'], sourceIds: vruSources,
    implementationTemplateId: 'bus-stop-emergence',
  },
  {
    id: 'transit.bus-pullout', title: 'Bus pulls from stop into occupied lane', domain: 'transit',
    summary: 'A bus re-enters traffic while ego is approaching alongside.',
    siteTypes: ['bus_stop'], requiredAffordances: ['stopPoint'],
    actors: [ego, other('bus', 'vehicle', 'Depart the stop and merge progressively into the lane.')],
    eventSequence: ['Bus signals departure.', 'Ego reaches the rear quarter.', 'Bus crosses the lane boundary.'],
    criticality: ['merge duration', 'rear-quarter overlap', 'available adjacent space'], sourceIds: vehicleSources,
    implementationTemplateId: 'transit.bus-pullout',
  },
  {
    id: 'school.child-dartout', title: 'School-zone child dart-out at pickup time', domain: 'work-and-school-zone',
    summary: 'A child runs from a pickup queue or curb activity into the travel lane.',
    siteTypes: ['school_zone'], requiredAffordances: ['pedestrianSpawn'],
    actors: [ego, other('child', 'pedestrian', 'Run toward the school frontage across the lane.'), other('pickup-vehicle', 'vehicle', 'Remain stopped and occlude the child.')],
    eventSequence: ['Pickup queue creates visual clutter.', 'Child separates from the curb group.', 'Child enters ego’s lane.'],
    criticality: ['school-zone approach speed', 'child reveal distance', 'queue occlusion'], sourceIds: vruSources,
    implementationTemplateId: 'school-dartout',
  },
  {
    id: 'school.crossing-guard-release', title: 'Vehicle encounters a late school crossing release', domain: 'work-and-school-zone',
    summary: 'A crossing group starts while an approaching vehicle is near the school crossing.',
    siteTypes: ['school_zone', 'crosswalk'], requiredAffordances: ['pedestrianSpawn'],
    actors: [ego, other('crossing-guard', 'pedestrian', 'Enter first and hold the crossing.'), other('child-group', 'pedestrian', 'Follow across with varied but bounded spacing.')],
    eventSequence: ['Guard approaches the crossing.', 'Guard enters and signals traffic to stop.', 'Children occupy the crossing behind the guard.'],
    criticality: ['guard entry timing', 'group extent', 'school-zone stopping distance'], sourceIds: vruSources,
    implementationTemplateId: 'school.crossing-guard-release',
  },
  {
    id: 'workzone.lane-shift', title: 'Temporary work-zone lane shift with a stopped queue', domain: 'work-and-school-zone',
    summary: 'Channelizing devices shift traffic laterally toward a short queue or worker area.',
    siteTypes: ['work_zone_suitable'], requiredAffordances: ['propPlacement', 'route'],
    actors: [ego, other('queue-tail', 'vehicle', 'Stop inside the shifted alignment.'), other('channelizer', 'object', 'Define a narrowing, traversable temporary path.')],
    eventSequence: ['Cones progressively close part of the lane.', 'Ego enters the shifted path.', 'A queue tail appears near the taper exit.'],
    criticality: ['taper rate', 'cone clearance', 'queue sight distance'], sourceIds: vehicleSources,
    implementationTemplateId: 'workzone.lane-shift',
  },
  {
    id: 'workzone.worker-intrusion', title: 'Worker steps outside the protected work area', domain: 'work-and-school-zone',
    summary: 'A worker briefly enters the open lane from behind equipment or barriers.',
    siteTypes: ['work_zone_suitable', 'midblock_segment'], requiredAffordances: ['propPlacement'],
    actors: [ego, other('worker', 'pedestrian', 'Step into the lane while attending to the work task.'), other('work-vehicle', 'vehicle', 'Remain static and partially occlude the worker.')],
    eventSequence: ['Ego approaches a marked work activity.', 'Worker moves past the occluder.', 'Worker occupies the lane edge or lane.'],
    criticality: ['worker reveal distance', 'work-zone speed', 'protected escape space'], sourceIds: [...vehicleSources, 'euroncap-aeb-vru'],
    implementationTemplateId: 'workzone.worker-intrusion',
  },
  {
    id: 'road-departure.curve-loss-control', title: 'Loss of control on a curve', domain: 'road-departure-and-obstacle',
    summary: 'Ego enters a bend too quickly for the available surface condition and drifts toward the edge.',
    siteTypes: ['midblock_segment', 'driving_corridor'], requiredAffordances: ['route'], preferredTags: ['CURVE'],
    actors: [ego, other('road-edge', 'object', 'Define the non-traversable edge and recovery boundary.')],
    eventSequence: ['Ego approaches the curve.', 'Required lateral acceleration exceeds the chosen margin.', 'Vehicle departs the intended lane unless speed is reduced.'],
    criticality: ['curve speed', 'surface friction', 'lane-edge excursion'], sourceIds: ['nhtsa-precrash-2007', 'nhtsa-precrash-2019'],
    implementationTemplateId: 'road-departure.curve-loss-control',
  },
  {
    id: 'obstacle.fallen-cargo', title: 'Fallen cargo blocks part of the lane', domain: 'road-departure-and-obstacle',
    summary: 'A nonmoving object becomes visible late enough to require controlled braking or avoidance.',
    siteTypes: ['midblock_segment', 'driving_corridor', 'occlusion_zone'], requiredAffordances: ['propPlacement'],
    actors: [ego, other('cargo', 'object', 'Remain stationary and physically occupy a bounded lane region.')],
    eventSequence: ['Cargo rests ahead.', 'Sight line reveals the object.', 'Ego brakes or avoids while retaining road boundaries.'],
    criticality: ['object reveal distance', 'occupied lane fraction', 'avoidance clearance'], sourceIds: ['nhtsa-precrash-2007', 'nhtsa-precrash-2019'],
    implementationTemplateId: 'obstacle.fallen-cargo',
  },
  {
    id: 'obstacle.animal-crossing', title: 'Animal runs into the roadway', domain: 'road-departure-and-obstacle',
    summary: 'An animal crosses rapidly from the roadside with limited warning.',
    siteTypes: ['midblock_segment', 'driving_corridor', 'occlusion_zone'], requiredAffordances: ['route'],
    actors: [ego, other('animal', 'object', 'Traverse the lane at a bounded running speed.')],
    eventSequence: ['Ego cruises through the segment.', 'Animal appears from the roadside.', 'Animal crosses the projected ego path.'],
    criticality: ['lateral crossing speed', 'first-visible range', 'avoidance stability'], sourceIds: ['nhtsa-precrash-2007', 'nhtsa-precrash-2019'],
    implementationTemplateId: 'obstacle.animal-crossing',
  },
  {
    id: 'obstacle.disabled-vehicle', title: 'Disabled vehicle occupies a live lane', domain: 'road-departure-and-obstacle',
    summary: 'A stationary disabled vehicle constrains the lane near a sight restriction.',
    siteTypes: ['midblock_segment', 'driving_corridor', 'occlusion_zone'], requiredAffordances: ['vehicleSpawn'],
    actors: [ego, other('disabled-vehicle', 'vehicle', 'Remain stationary with a plausible roadside orientation.'), other('stranded-occupant', 'pedestrian', 'Stay near the vehicle but outside ego’s nominal path.')],
    eventSequence: ['Disabled vehicle is stationary.', 'Ego receives limited preview.', 'Ego must stop or pass with safe occupant clearance.'],
    criticality: ['preview distance', 'pass clearance', 'occupant exposure'], sourceIds: vehicleSources,
    implementationTemplateId: 'obstacle.disabled-vehicle',
  },
] as const;

export const OPERATIONAL_VARIANTS = [
  { id: 'weekday-clear', title: 'Weekday clear daylight', weather: 'clear', timeOfDay: 'day', traffic: 'moderate', visibility: 'unrestricted except authored occluders' },
  { id: 'dusk-commute', title: 'Dusk commute', weather: 'clear', timeOfDay: 'dusk', traffic: 'heavy', visibility: 'reduced contrast and traffic occlusion' },
  { id: 'wet-night', title: 'Wet night', weather: 'rain', timeOfDay: 'night', traffic: 'light', visibility: 'headlight-limited with wet-road reflections' },
  { id: 'dawn-glare', title: 'Low-angle dawn glare', weather: 'clear', timeOfDay: 'dawn', traffic: 'moderate', visibility: 'directional glare with otherwise clear air' },
  { id: 'weekend-busy', title: 'Busy weekend activity', weather: 'overcast', timeOfDay: 'day', traffic: 'heavy', visibility: 'dense actor and parked-vehicle occlusion' },
] as const;

export type OperationalVariant = (typeof OPERATIONAL_VARIANTS)[number];
