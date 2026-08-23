import type {
  CatalogActorClass,
  CatalogEntry,
  ExternalModelBinding,
  PropClass,
  PropTag,
} from './types';
export const EXTERNAL_CATALOG_PREFIXES = ['gallery.', 'carla.'] as const;
export type ExternalCatalogEntry = Omit<CatalogEntry, 'id'> & {
  readonly id: string;
  readonly model: ExternalModelBinding;
};


/**
 * The catalog is the contract: other packages address props by `id` and select
 * them by `class`/`tags`, never by importing a builder directly. Hi-fi meshes
 * can replace the procedural builders later behind these same ids.
 *
 * `dims` are the real-world extents of the default build and are asserted
 * against the built bounding box in the test suite, so they cannot drift.
 */
export const CATALOG = [
  // ---------------------------------------------------------------- vehicles
  {
    id: 'vehicle.sedan',
    label: 'Sedan',
    class: 'vehicle',
    actorClass: 'car',
    description:
      'Mid-size four-door passenger car. The default other-vehicle: use it for lead, following and oncoming traffic when nothing special is required.',
    dims: { l: 4.7, w: 1.82, h: 1.45 },
    tags: ['occlusion:medium', 'mobile', 'parkable', 'roadway'],
    defaultParams: { color: '#2f4f74' },
  },
  {
    id: 'vehicle.hatchback',
    label: 'Hatchback',
    class: 'vehicle',
    actorClass: 'car',
    description:
      'Compact five-door hatchback. Short, agile city car — good for tight parking rows and gap-acceptance scenarios.',
    dims: { l: 4.05, w: 1.75, h: 1.46 },
    tags: ['occlusion:medium', 'mobile', 'parkable', 'roadway'],
    defaultParams: { color: '#8f2f2f' },
  },
  {
    id: 'vehicle.suv',
    label: 'SUV',
    class: 'vehicle',
    actorClass: 'car',
    description:
      'Mid-size sport-utility vehicle. Tall enough to hide a child or a cyclist from a following driver; the common suburban parked vehicle.',
    dims: { l: 4.85, w: 1.95, h: 1.78 },
    tags: ['occlusion:medium', 'mobile', 'parkable', 'roadway'],
    defaultParams: { color: '#25282c' },
  },
  {
    id: 'vehicle.pickup',
    label: 'Pickup truck',
    class: 'vehicle',
    actorClass: 'truck',
    compatibleActorClasses: ['car'],
    description:
      'Full-size crew-cab pickup with an open bed. Long and tall; a parked one at a kerb blocks the sightline into a driveway.',
    dims: { l: 5.9, w: 2.03, h: 1.95 },
    tags: ['occlusion:medium', 'mobile', 'parkable', 'roadway'],
    defaultParams: { color: '#5a6068' },
  },
  {
    id: 'vehicle.van',
    label: 'Cargo van',
    class: 'vehicle',
    actorClass: 'van',
    description:
      'High-roof delivery van. A double-parked one is the canonical occluder for a pedestrian stepping out mid-block.',
    dims: { l: 5.3, w: 2.0, h: 2.4 },
    tags: ['occlusion:high', 'mobile', 'parkable', 'roadway'],
    defaultParams: { color: '#e8e9ea' },
  },
  {
    id: 'vehicle.kia.carnival',
    label: 'Kia Carnival 2025',
    class: 'vehicle',
    actorClass: 'van',
    compatibleActorClasses: ['car'],
    description:
      'Pronto sensor-platform vehicle. Browser presentation matches the production Kia Carnival dimensions; CARLA binds this identity to the packaged KiaCarnival2025 blueprint.',
    dims: { l: 5.15, w: 2.0, h: 1.78 },
    tags: ['occlusion:medium', 'mobile', 'parkable', 'roadway'],
    defaultParams: { color: '#f1f2f3' },
  },
  {
    id: 'vehicle.box_truck',
    label: 'Box truck',
    class: 'vehicle',
    actorClass: 'truck',
    description:
      'Two-axle straight truck with a 24 ft cargo body. Completely blocks the sightline across an adjacent lane.',
    dims: { l: 7.6, w: 2.44, h: 3.4 },
    tags: ['occlusion:high', 'mobile', 'roadway', 'large-vehicle'],
    defaultParams: { color: '#e8e9ea' },
  },
  {
    id: 'vehicle.semi_truck',
    label: 'Semi tractor-trailer',
    class: 'vehicle',
    actorClass: 'truck',
    description:
      'Conventional tractor with a 53 ft box trailer. The strongest mobile occluder in the catalog and the reference articulated vehicle for turning and blind-spot cases.',
    dims: { l: 20.1, w: 2.6, h: 4.1 },
    tags: ['occlusion:high', 'mobile', 'roadway', 'large-vehicle'],
    defaultParams: { color: '#8f2f2f' },
  },
  {
    id: 'vehicle.bus',
    label: 'Transit bus',
    class: 'vehicle',
    actorClass: 'bus',
    description:
      'Forty-foot city bus with kerb-side doors. Stopped at a bus stop it hides boarding and alighting pedestrians from through traffic.',
    dims: { l: 12.2, w: 2.55, h: 3.2 },
    tags: ['occlusion:high', 'mobile', 'roadway', 'large-vehicle'],
    defaultParams: { color: '#2f5b45' },
  },
  {
    id: 'vehicle.motorcycle',
    label: 'Motorcycle',
    class: 'vehicle',
    actorClass: 'motorcycle',
    description:
      'Standard motorcycle, no rider. Narrow silhouette used for lane-filtering, late-detection and misclassification cases.',
    dims: { l: 2.1, w: 0.75, h: 1.23 },
    tags: ['occlusion:low', 'mobile', 'vru', 'parkable', 'roadway'],
    defaultParams: { color: '#25282c' },
  },
  {
    id: 'vehicle.bicycle',
    label: 'Cyclist',
    class: 'vehicle',
    actorClass: 'bicycle',
    description:
      'Bicycle with a seated rider. The reference vulnerable road user for bike-lane, dooring and right-hook conflicts.',
    dims: { l: 1.75, w: 0.5, h: 1.71 },
    tags: ['occlusion:low', 'mobile', 'vru', 'roadway'],
    defaultParams: { color: '#2f4f74' },
  },
  {
    id: 'vehicle.ambulance',
    label: 'Ambulance',
    class: 'vehicle',
    actorClass: 'van',
    compatibleActorClasses: ['truck'],
    description:
      'Box-body emergency ambulance with a roof light bar. Use lights.emergency and audio.horn timeline state keys for emergency-response conflicts.',
    dims: { l: 6.1, w: 2.1, h: 2.65 },
    tags: ['occlusion:high', 'mobile', 'roadway', 'large-vehicle'],
    defaultParams: { color: '#eceff1' },
  },
  {
    id: 'vehicle.tram',
    label: 'Tram / streetcar',
    class: 'vehicle',
    actorClass: 'bus',
    compatibleActorClasses: ['truck'],
    description:
      'Single articulated urban tram for rail-crossing, mixed-traffic and platform conflicts. Its long fixed-path body is a strong moving occluder.',
    dims: { l: 30, w: 2.65, h: 3.5 },
    tags: ['occlusion:high', 'mobile', 'roadway', 'large-vehicle'],
    defaultParams: { color: '#d9e2e8' },
  },
  {
    id: 'vehicle.mobility_scooter',
    label: 'Mobility scooter',
    class: 'vehicle',
    actorClass: 'scooter',
    description:
      'Low-speed powered mobility scooter with a seated rider. Treat as a vulnerable road user for crossing and sidewalk-edge interactions.',
    dims: { l: 1.35, w: 0.68, h: 1.35 },
    tags: ['occlusion:low', 'mobile', 'vru', 'sidewalk'],
    defaultParams: { color: '#287ba8' },
  },
  {
    id: 'vehicle.honda_civic',
    label: 'Honda Civic',
    class: 'vehicle',
    actorClass: 'car',
    description:
      'Contemporary Honda Civic compact sedan for recognizable everyday traffic, commuter, parking and intersection scenarios.',
    dims: { l: 4.67, w: 1.8, h: 1.42 },
    tags: ['occlusion:medium', 'mobile', 'parkable', 'roadway', 'passenger'],
    defaultParams: { color: '#4b5563' },
  },
  {
    id: 'vehicle.toyota_camry',
    label: 'Toyota Camry',
    class: 'vehicle',
    actorClass: 'car',
    description:
      'Modern Toyota Camry family sedan for common commuter traffic, rideshare pickup and parked-car occlusion scenes.',
    dims: { l: 4.88, w: 1.84, h: 1.45 },
    tags: ['occlusion:medium', 'mobile', 'parkable', 'roadway', 'passenger'],
    defaultParams: { color: '#c8cbd0' },
  },
  {
    id: 'vehicle.tesla_model_3',
    label: 'Tesla Model 3',
    class: 'vehicle',
    actorClass: 'car',
    description:
      'Tesla Model 3 electric fastback with a low grille-free nose for modern mixed-fleet and charging-area scenarios.',
    dims: { l: 4.72, w: 1.85, h: 1.44 },
    tags: ['occlusion:medium', 'mobile', 'parkable', 'roadway', 'passenger'],
    defaultParams: { color: '#f2f3f4' },
  },
  {
    id: 'vehicle.ford_mustang',
    label: 'Ford Mustang',
    class: 'vehicle',
    actorClass: 'car',
    description:
      'Ford Mustang two-door performance coupe with a long hood for recognizable enthusiast and high-acceleration traffic scenes.',
    dims: { l: 4.81, w: 1.92, h: 1.4 },
    tags: ['occlusion:medium', 'mobile', 'parkable', 'roadway', 'passenger'],
    defaultParams: { color: '#1f5fa8' },
  },
  {
    id: 'vehicle.chevrolet_corvette',
    label: 'Chevrolet Corvette',
    class: 'vehicle',
    actorClass: 'car',
    description:
      'Chevrolet Corvette low sports car with a wide stance for performance-driving and difficult low-profile detection scenarios.',
    dims: { l: 4.63, w: 1.93, h: 1.23 },
    tags: ['occlusion:low', 'mobile', 'parkable', 'roadway', 'passenger'],
    defaultParams: { color: '#d62828' },
  },
  {
    id: 'vehicle.porsche_911',
    label: 'Porsche 911',
    class: 'vehicle',
    actorClass: 'car',
    description:
      'Porsche 911 sports coupe with its compact rounded roofline for premium urban traffic and performance scenarios.',
    dims: { l: 4.52, w: 1.85, h: 1.3 },
    tags: ['occlusion:low', 'mobile', 'parkable', 'roadway', 'passenger'],
    defaultParams: { color: '#d9dde2' },
  },
  {
    id: 'vehicle.jeep_wrangler',
    label: 'Jeep Wrangler',
    class: 'vehicle',
    actorClass: 'car',
    description:
      'Four-door Jeep Wrangler with an upright cabin and exposed spare-wheel silhouette for urban and trail-access scenes.',
    dims: { l: 4.79, w: 1.88, h: 1.87 },
    tags: ['occlusion:medium', 'mobile', 'parkable', 'roadway', 'passenger'],
    defaultParams: { color: '#49633d' },
  },
  {
    id: 'vehicle.minivan',
    label: 'Passenger minivan',
    class: 'vehicle',
    actorClass: 'van',
    description:
      'Seven-seat passenger minivan for school pickup, family travel, rideshare and sliding-door curbside conflicts.',
    dims: { l: 5.15, w: 2, h: 1.78 },
    tags: ['occlusion:medium', 'mobile', 'parkable', 'roadway', 'passenger'],
    defaultParams: { color: '#6f7782' },
  },
  {
    id: 'vehicle.taxi',
    label: 'City taxi',
    class: 'vehicle',
    actorClass: 'car',
    description:
      'Marked city taxi with a roof sign for curb pickup, sudden stopping, passenger loading and dense downtown traffic.',
    dims: { l: 4.9, w: 1.85, h: 1.55 },
    tags: ['occlusion:medium', 'mobile', 'parkable', 'roadway', 'passenger', 'service'],
    defaultParams: { color: '#f0c419' },
  },
  {
    id: 'vehicle.police_cruiser',
    label: 'Police cruiser',
    class: 'vehicle',
    actorClass: 'car',
    description:
      'Marked police sedan with a roof light bar for traffic stops, pursuits, blocked lanes and emergency-priority scenarios.',
    dims: { l: 5.1, w: 2, h: 1.55 },
    tags: ['occlusion:medium', 'mobile', 'parkable', 'roadway', 'emergency', 'service'],
    defaultParams: { color: '#1f2937' },
  },
  {
    id: 'vehicle.police_suv',
    label: 'Police SUV',
    class: 'vehicle',
    actorClass: 'car',
    description:
      'Marked police utility vehicle with emergency lighting for incident command, pursuits and roadside response scenes.',
    dims: { l: 5.1, w: 2, h: 1.9 },
    tags: ['occlusion:medium', 'mobile', 'parkable', 'roadway', 'emergency', 'service'],
    defaultParams: { color: '#e9ecef' },
  },
  {
    id: 'vehicle.fire_command_suv',
    label: 'Fire command SUV',
    class: 'vehicle',
    actorClass: 'car',
    description:
      'Red fire-department command SUV with warning lights for advance response, road closures and incident staging.',
    dims: { l: 5.2, w: 2, h: 1.95 },
    tags: ['occlusion:medium', 'mobile', 'parkable', 'roadway', 'emergency', 'service'],
    defaultParams: { color: '#b91c1c' },
  },
  {
    id: 'vehicle.fire_engine',
    label: 'Fire engine',
    class: 'vehicle',
    actorClass: 'truck',
    description:
      'Full-size structural fire engine with equipment body, ladder and emergency light bar for active incident scenes.',
    dims: { l: 10.2, w: 2.55, h: 3.3 },
    tags: ['occlusion:high', 'mobile', 'roadway', 'large-vehicle', 'emergency', 'service'],
    defaultParams: { color: '#b91c1c' },
  },
  {
    id: 'vehicle.dump_truck',
    label: 'Dump truck',
    class: 'vehicle',
    actorClass: 'truck',
    description:
      'Three-axle dump truck with a raised-sided aggregate bed for construction traffic, work zones and blind-spot cases.',
    dims: { l: 8.5, w: 2.55, h: 3.3 },
    tags: ['occlusion:high', 'mobile', 'roadway', 'large-vehicle', 'commercial', 'workzone'],
    defaultParams: { color: '#e1a11a' },
  },
  {
    id: 'vehicle.garbage_truck',
    label: 'Garbage truck',
    class: 'vehicle',
    actorClass: 'truck',
    description:
      'Municipal refuse collection truck with a tall compactor body for frequent curb stops and neighborhood occlusion scenarios.',
    dims: { l: 9.2, w: 2.55, h: 3.45 },
    tags: ['occlusion:high', 'mobile', 'roadway', 'large-vehicle', 'commercial', 'service'],
    defaultParams: { color: '#2f855a' },
  },
  {
    id: 'vehicle.tow_truck',
    label: 'Tow truck',
    class: 'vehicle',
    actorClass: 'truck',
    description:
      'Medium-duty rollback tow truck for disabled-vehicle recovery, shoulder operations and partially blocked traffic lanes.',
    dims: { l: 7.5, w: 2.45, h: 2.8 },
    tags: ['occlusion:high', 'mobile', 'roadway', 'large-vehicle', 'commercial', 'service'],
    defaultParams: { color: '#f59e0b' },
  },
  {
    id: 'vehicle.cement_mixer',
    label: 'Cement mixer',
    class: 'vehicle',
    actorClass: 'truck',
    description:
      'Heavy concrete mixer truck with a rotating-drum silhouette for construction deliveries, turns and large blind spots.',
    dims: { l: 8.8, w: 2.5, h: 3.7 },
    tags: ['occlusion:high', 'mobile', 'roadway', 'large-vehicle', 'commercial', 'workzone'],
    defaultParams: { color: '#e5e7eb' },
  },
  {
    id: 'vehicle.utility_bucket_truck',
    label: 'Utility bucket truck',
    class: 'vehicle',
    actorClass: 'truck',
    description:
      'Utility service truck with a folded aerial bucket boom for roadside maintenance, lane closures and worker-safety scenes.',
    dims: { l: 8.2, w: 2.5, h: 3.6 },
    tags: ['occlusion:high', 'mobile', 'roadway', 'large-vehicle', 'service', 'workzone'],
    defaultParams: { color: '#f8fafc' },
  },
  {
    id: 'vehicle.tanker_truck',
    label: 'Tanker truck',
    class: 'vehicle',
    actorClass: 'truck',
    description:
      'Rigid tanker truck with a cylindrical liquid tank for hazardous-goods routing, turning and high-occlusion scenarios.',
    dims: { l: 10.5, w: 2.55, h: 3.6 },
    tags: ['occlusion:high', 'mobile', 'roadway', 'large-vehicle', 'commercial'],
    defaultParams: { color: '#d7dce1' },
  },
  {
    id: 'vehicle.flatbed_truck',
    label: 'Flatbed truck',
    class: 'vehicle',
    actorClass: 'truck',
    description:
      'Medium-duty flatbed truck for oversized cargo, loading activity and variable roadside obstruction scenarios.',
    dims: { l: 8, w: 2.5, h: 2.65 },
    tags: ['occlusion:high', 'mobile', 'roadway', 'large-vehicle', 'commercial'],
    defaultParams: { color: '#475569' },
  },
  {
    id: 'vehicle.school_bus',
    label: 'School bus',
    class: 'vehicle',
    actorClass: 'bus',
    description:
      'Conventional yellow school bus for pupil loading, flashing-stop conflicts and child pedestrian occlusion scenarios.',
    dims: { l: 10.7, w: 2.55, h: 3.2 },
    tags: ['occlusion:high', 'mobile', 'roadway', 'large-vehicle', 'service'],
    defaultParams: { color: '#e8b51b' },
  },
  {
    id: 'vehicle.shuttle_bus',
    label: 'Shuttle bus',
    class: 'vehicle',
    actorClass: 'bus',
    description:
      'Medium passenger shuttle bus for airport, hotel, campus and paratransit pickup and drop-off interactions.',
    dims: { l: 7.4, w: 2.3, h: 2.8 },
    tags: ['occlusion:high', 'mobile', 'roadway', 'large-vehicle', 'service'],
    defaultParams: { color: '#e2e8f0' },
  },
  {
    id: 'vehicle.delivery_van',
    label: 'Parcel delivery van',
    class: 'vehicle',
    actorClass: 'van',
    description:
      'Long-wheelbase parcel delivery van for frequent curb stops, double parking and driver-exit conflict scenarios.',
    dims: { l: 6, w: 2.05, h: 2.65 },
    tags: ['occlusion:high', 'mobile', 'parkable', 'roadway', 'delivery', 'commercial'],
    defaultParams: { color: '#8b5e3c' },
  },

  // ------------------------------------------------------------- pedestrians
  {
    id: 'pedestrian.adult',
    label: 'Adult pedestrian',
    class: 'pedestrian',
    description:
      'Adult pedestrian, 1.75 m. Walking, standing and other motion are authored separately in the timeline.',
    dims: { l: 0.32, w: 0.5, h: 1.75 },
    tags: ['vru', 'occlusion:low', 'sidewalk'],
    defaultParams: { height: 1.75, pose: 'standing' },
  },
  {
    id: 'pedestrian.child',
    label: 'Child pedestrian',
    class: 'pedestrian',
    description:
      'Child pedestrian, 1.20 m — short enough to be hidden by a parked sedan. Motion is authored separately in the timeline.',
    dims: { l: 0.24, w: 0.35, h: 1.2 },
    tags: ['vru', 'occlusion:low', 'sidewalk'],
    defaultParams: { height: 1.2, pose: 'standing' },
  },
  {
    id: 'pedestrian.adult_standing',
    label: 'Adult standing (legacy id)',
    class: 'pedestrian',
    description:
      'Backward-compatible adult pedestrian preset retained for saved scenarios; new authoring should use pedestrian.adult with a timeline action.',
    dims: { l: 0.32, w: 0.5, h: 1.75 },
    tags: ['vru', 'occlusion:low', 'sidewalk'],
    defaultParams: { height: 1.75, pose: 'standing' },
    legacyAliasOf: 'pedestrian.adult',
  },
  {
    id: 'pedestrian.adult_walking',
    label: 'Adult walking (legacy id)',
    class: 'pedestrian',
    description:
      'Backward-compatible walking adult preset retained for saved scenarios; new authoring should use pedestrian.adult with timeline motion.',
    dims: { l: 0.85, w: 0.5, h: 1.75 },
    tags: ['vru', 'occlusion:low', 'sidewalk'],
    defaultParams: { height: 1.75, pose: 'walking' },
    legacyAliasOf: 'pedestrian.adult',
  },
  {
    id: 'pedestrian.child_standing',
    label: 'Child standing (legacy id)',
    class: 'pedestrian',
    description:
      'Backward-compatible child pedestrian preset retained for saved scenarios; new authoring should use pedestrian.child with a timeline action.',
    dims: { l: 0.24, w: 0.35, h: 1.2 },
    tags: ['vru', 'occlusion:low', 'sidewalk'],
    defaultParams: { height: 1.2, pose: 'standing' },
    legacyAliasOf: 'pedestrian.child',
  },
  {
    id: 'pedestrian.child_walking',
    label: 'Child walking (legacy id)',
    class: 'pedestrian',
    description:
      'Backward-compatible walking child preset retained for saved scenarios; new authoring should use pedestrian.child with timeline motion.',
    dims: { l: 0.58, w: 0.35, h: 1.2 },
    tags: ['vru', 'occlusion:low', 'sidewalk'],
    defaultParams: { height: 1.2, pose: 'walking' },
    legacyAliasOf: 'pedestrian.child',
  },
  {
    id: 'pedestrian.traffic_marshal',
    label: 'Traffic marshal / police director',
    class: 'pedestrian',
    description:
      'High-visibility traffic marshal with a raised directing arm. Use pose.gesture timeline states to halt or wave traffic through.',
    dims: { l: 0.72, w: 0.68, h: 1.88 },
    tags: ['vru', 'workzone', 'occlusion:low', 'roadway'],
    defaultParams: { height: 1.82, pose: 'standing' },
  },

  // --------------------------------------------------------- sidewalk robots
  {
    id: 'sidewalk_robot.delivery_rover',
    label: 'Delivery rover',
    class: 'sidewalk_robot',
    description:
      'Six-sensor autonomous delivery rover sized for pavements and crossings, with an animated wheel-and-lidar locomotion rig.',
    dims: { l: .75, w: .55, h: .8 },
    tags: ['occlusion:low', 'mobile', 'sidewalk', 'autonomous', 'delivery'],
    defaultParams: { color: '#f1a34f' },
    animation: { rig: 'wheeled', clips: ['idle', 'drive', 'open_lid'], idleClip: 'idle', locomotionClip: 'drive' },
  },
  {
    id: 'sidewalk_robot.cooler_bot',
    label: 'Food delivery cooler bot',
    class: 'sidewalk_robot',
    description:
      'Large insulated food-delivery robot with animated wheels, suspension, lid, lights and sensor mast for busy-sidewalk scenes.',
    dims: { l: .95, w: .65, h: .95 },
    tags: ['occlusion:low', 'mobile', 'sidewalk', 'autonomous', 'delivery'],
    defaultParams: { color: '#edf1f4' },
    animation: { rig: 'wheeled', clips: ['idle', 'drive', 'open_lid'], idleClip: 'idle', locomotionClip: 'drive' },
  },
  {
    id: 'sidewalk_robot.quadruped_courier',
    label: 'Quadruped courier robot',
    class: 'sidewalk_robot',
    description:
      'Four-legged autonomous courier robot with a cargo pod and articulated walk, idle-balance and sit animations.',
    dims: { l: 1.05, w: .5, h: .72 },
    tags: ['occlusion:low', 'mobile', 'sidewalk', 'autonomous', 'delivery'],
    defaultParams: { color: '#e6b84f' },
    animation: { rig: 'quadruped', clips: ['idle', 'walk', 'sit'], idleClip: 'idle', locomotionClip: 'walk' },
  },
  {
    id: 'sidewalk_robot.humanoid_general_purpose',
    label: 'General-purpose humanoid',
    class: 'sidewalk_robot',
    description:
      'Full-height bipedal service robot with articulated hands, head, torso and walking rig for general public-space scenarios.',
    dims: { l: .58, w: .62, h: 1.78 },
    tags: ['occlusion:low', 'mobile', 'sidewalk', 'autonomous', 'service'],
    defaultParams: { color: '#e8edf2' },
    animation: { rig: 'humanoid', clips: ['idle', 'walk', 'run', 'wave', 'pick_up'], idleClip: 'idle', locomotionClip: 'walk' },
  },
  {
    id: 'sidewalk_robot.humanoid_delivery',
    label: 'Humanoid delivery robot',
    class: 'sidewalk_robot',
    description:
      'Bipedal last-metre delivery robot carrying a parcel pod, animated for walking, handoff and door interaction scenes.',
    dims: { l: .62, w: .68, h: 1.7 },
    tags: ['occlusion:low', 'mobile', 'sidewalk', 'autonomous', 'delivery'],
    defaultParams: { color: '#f0a44b' },
    animation: { rig: 'humanoid', clips: ['idle', 'walk', 'carry', 'handoff', 'open_door'], idleClip: 'idle', locomotionClip: 'walk' },
  },
  {
    id: 'sidewalk_robot.humanoid_warehouse',
    label: 'Warehouse humanoid',
    class: 'sidewalk_robot',
    description:
      'Industrial humanoid worker with protective limbs and grasping hands for loading docks, depots and logistics yards.',
    dims: { l: .64, w: .7, h: 1.75 },
    tags: ['occlusion:low', 'mobile', 'sidewalk', 'autonomous', 'commercial'],
    defaultParams: { color: '#d8a31a' },
    animation: { rig: 'humanoid', clips: ['idle', 'walk', 'lift', 'carry', 'place'], idleClip: 'idle', locomotionClip: 'walk' },
  },
  {
    id: 'sidewalk_robot.humanoid_public_safety',
    label: 'Public-safety humanoid',
    class: 'sidewalk_robot',
    description:
      'High-visibility humanoid response robot for directing pedestrians, inspecting hazards and assisting emergency crews.',
    dims: { l: .62, w: .68, h: 1.82 },
    tags: ['occlusion:low', 'mobile', 'sidewalk', 'autonomous', 'emergency', 'service'],
    defaultParams: { color: '#ef4444' },
    animation: { rig: 'humanoid', clips: ['idle', 'walk', 'signal_stop', 'point', 'inspect'], idleClip: 'idle', locomotionClip: 'walk' },
  },
  {
    id: 'sidewalk_robot.humanoid_construction',
    label: 'Construction humanoid',
    class: 'sidewalk_robot',
    description:
      'Rugged humanoid work robot with a safety helmet and tool mount for roadworks, inspection and repair operations.',
    dims: { l: .66, w: .72, h: 1.85 },
    tags: ['occlusion:low', 'mobile', 'sidewalk', 'autonomous', 'workzone', 'service'],
    defaultParams: { color: '#f59e0b' },
    animation: { rig: 'humanoid', clips: ['idle', 'walk', 'carry_tool', 'inspect', 'kneel'], idleClip: 'idle', locomotionClip: 'walk' },
  },

  // ------------------------------------------------------------------ drones
  {
    id: 'drone.delivery_quadcopter',
    label: 'Delivery quadcopter',
    class: 'drone',
    description:
      'Parcel-carrying autonomous quadcopter with animated rotors, gimbal, landing gear and a three-metre default hover height.',
    dims: { l: 1.1, w: 1.1, h: .45 },
    tags: ['occlusion:low', 'mobile', 'aerial', 'autonomous', 'delivery'],
    defaultParams: { color: '#444c57' },
    animation: { rig: 'rotorcraft', clips: ['idle', 'fly', 'land', 'deliver'], idleClip: 'idle', locomotionClip: 'fly', hoverHeightM: 3 },
  },
  {
    id: 'drone.camera_quadcopter',
    label: 'Camera drone',
    class: 'drone',
    description:
      'Compact camera quadcopter with animated rotors and gimbal for filming, inspection and low-altitude perception scenarios.',
    dims: { l: .65, w: .65, h: .32 },
    tags: ['occlusion:low', 'mobile', 'aerial', 'autonomous'],
    defaultParams: { color: '#343a42' },
    animation: { rig: 'rotorcraft', clips: ['idle', 'fly', 'orbit', 'land'], idleClip: 'idle', locomotionClip: 'fly', hoverHeightM: 4 },
  },
  {
    id: 'drone.emergency_responder',
    label: 'Emergency responder drone',
    class: 'drone',
    description:
      'Large first-responder drone with animated rotors, gimbal and warning beacon for incident response and emergency-route scenes.',
    dims: { l: 1.4, w: 1.4, h: .5 },
    tags: ['occlusion:low', 'mobile', 'aerial', 'autonomous'],
    defaultParams: { color: '#e9edf2' },
    animation: { rig: 'rotorcraft', clips: ['idle', 'fly', 'hover_scan', 'land'], idleClip: 'idle', locomotionClip: 'fly', hoverHeightM: 5 },
  },

  // ----------------------------------------------------------------- animals
  {
    id: 'animal.dog',
    label: 'Dog',
    class: 'animal',
    description: 'Medium dog with idle, walk, run and sit clips for domestic-animal crossings and owner-separation scenarios.',
    dims: { l: 1.07, w: 0.3, h: 0.75 },
    tags: ['occlusion:low', 'mobile', 'vru', 'sidewalk', 'domestic'],
    defaultParams: { color: '#a8834f' },
    animation: { rig: 'quadruped', clips: ['idle', 'walk', 'run', 'sit'], idleClip: 'idle', locomotionClip: 'walk' },
  },
  {
    id: 'animal.cat',
    label: 'Cat',
    class: 'animal',
    description: 'Domestic cat with idle, walk, run and crouch clips for small, easily occluded sidewalk and roadway conflicts.',
    dims: { l: 0.63, w: 0.15, h: 0.35 },
    tags: ['occlusion:low', 'mobile', 'vru', 'sidewalk', 'domestic'],
    defaultParams: { color: '#5c5750' },
    animation: { rig: 'quadruped', clips: ['idle', 'walk', 'run', 'crouch'], idleClip: 'idle', locomotionClip: 'walk' },
  },
  {
    id: 'animal.deer',
    label: 'Deer',
    class: 'animal',
    description: 'Adult deer with alert-idle, walk and bound clips for high-severity wildlife incursions on suburban and rural roads.',
    dims: { l: 1.76, w: 0.46, h: 1.62 },
    tags: ['occlusion:medium', 'mobile', 'vru', 'roadside', 'wildlife'],
    defaultParams: { color: '#9c7b52' },
    animation: { rig: 'quadruped', clips: ['alert_idle', 'walk', 'bound'], idleClip: 'alert_idle', locomotionClip: 'walk' },
  },
  {
    id: 'animal.raccoon',
    label: 'Raccoon',
    class: 'animal',
    description: 'Raccoon with sniff-idle, walk and scurry clips for nocturnal curbside, refuse-area and sudden-crossing scenarios.',
    dims: { l: .85, w: .22, h: .45 },
    tags: ['occlusion:low', 'mobile', 'vru', 'roadside', 'wildlife'],
    defaultParams: { color: '#666b70' },
    animation: { rig: 'quadruped', clips: ['sniff_idle', 'walk', 'scurry'], idleClip: 'sniff_idle', locomotionClip: 'walk' },
  },
  {
    id: 'animal.goose',
    label: 'Goose',
    class: 'animal',
    description: 'Adult goose with idle, waddle, run and wing-display clips for flock crossings near parks, ponds and campuses.',
    dims: { l: .86, w: .5, h: .85 },
    tags: ['occlusion:low', 'mobile', 'vru', 'sidewalk', 'wildlife'],
    defaultParams: { color: '#d8d8cf' },
    animation: { rig: 'avian', clips: ['idle', 'waddle', 'run', 'wing_display'], idleClip: 'idle', locomotionClip: 'waddle' },
  },

  // ------------------------------------------------------------ construction
  {
    id: 'construction.traffic_cone',
    label: 'Traffic cone',
    class: 'construction',
    description:
      'Standard 700 mm orange channelizing cone with two reflective bands. The unit of any taper or lane closure.',
    dims: { l: 0.36, w: 0.36, h: 0.7 },
    tags: ['workzone', 'occlusion:low', 'roadway'],
    defaultParams: { height: 0.7 },
  },
  {
    id: 'construction.channelizer_drum',
    label: 'Channelizer drum',
    class: 'construction',
    description:
      'Plastic 1070 mm drum with four reflective bands. Delineates long-duration work areas; more conspicuous than a cone.',
    dims: { l: 0.58, w: 0.58, h: 1.07 },
    tags: ['workzone', 'occlusion:low', 'roadway'],
    defaultParams: {},
  },
  {
    id: 'construction.barricade_type3',
    label: 'Type III barricade',
    class: 'construction',
    description:
      'Full 8 ft type-III barricade with three striped rails and a warning light. Used to close a road or a ramp outright.',
    dims: { l: 0.62, w: 2.44, h: 1.66 },
    tags: ['workzone', 'occlusion:medium', 'roadway'],
    defaultParams: {},
  },
  {
    id: 'construction.pedestrian_barrier',
    label: 'Pedestrian barrier',
    class: 'construction',
    description:
      'Lightweight interlocking crowd-control barrier used to separate pedestrians from a temporary traffic lane or event egress route.',
    dims: { l: 2, w: 0.55, h: 1.1 },
    tags: ['workzone', 'occlusion:low', 'roadway'],
    defaultParams: {},
  },
  {
    id: 'construction.jersey_barrier',
    label: 'Jersey barrier',
    class: 'construction',
    description:
      'Single precast concrete barrier segment, 10 ft. Hard separation between live traffic and a work area.',
    dims: { l: 3.05, w: 0.61, h: 0.81 },
    tags: ['workzone', 'occlusion:medium', 'roadway'],
    defaultParams: { length: 3.05 },
  },
  {
    id: 'construction.jersey_barrier_run',
    label: 'Jersey barrier run',
    class: 'construction',
    description:
      'Continuous line of jersey barriers of a given length, running along +X. Use to wall off a work zone or a contraflow.',
    dims: { l: 12.2, w: 0.61, h: 0.81 },
    tags: ['workzone', 'occlusion:medium', 'roadway', 'run'],
    defaultParams: { length: 12.2, segmentLength: 3.05 },
  },
  {
    id: 'construction.sign_road_work',
    label: 'Road work sign',
    class: 'construction',
    description:
      'Orange 48 in diamond warning sign on a portable stand (ROAD WORK AHEAD style), facing +X. Place upstream of every closure.',
    dims: { l: 0.9, w: 1.73, h: 2.21 },
    tags: ['workzone', 'occlusion:medium', 'roadside'],
    defaultParams: { boardSize: 1.22, textLines: 3 },
  },
  {
    id: 'construction.flagger',
    label: 'Flagger',
    class: 'construction',
    actorClass: 'pedestrian',
    description:
      'Worker in a hi-vis vest and hard hat holding a STOP/SLOW paddle out to the side. A vulnerable road user standing in the roadway.',
    dims: { l: 0.73, w: 0.7, h: 2.19 },
    tags: ['workzone', 'vru', 'occlusion:low', 'roadway'],
    defaultParams: { height: 1.78, paddle: 'stop' },
  },
  {
    id: 'construction.arrow_board',
    label: 'Arrow board trailer',
    class: 'construction',
    description:
      'Trailer-mounted flashing arrow board directing traffic left or right. Sits at the start of a lane-closure taper.',
    dims: { l: 3.45, w: 2.44, h: 2.53 },
    tags: ['workzone', 'occlusion:medium', 'roadway'],
    defaultParams: { direction: 'left', raised: true },
  },
  {
    id: 'construction.excavator',
    label: 'Excavator',
    class: 'construction',
    description:
      'Tracked excavator with the boom stowed forward. A large static machine inside a work area; blocks sightlines completely.',
    dims: { l: 5.15, w: 2.24, h: 2.71 },
    tags: ['workzone', 'occlusion:high', 'roadway', 'large-vehicle'],
    defaultParams: {},
  },
  {
    id: 'construction.portable_toilet',
    label: 'Portable toilet',
    class: 'construction',
    description:
      'Site toilet cabin, 2.3 m tall on a 1.16 m footprint. Small, very tall occluder often parked right at a kerb line.',
    dims: { l: 1.24, w: 1.22, h: 2.26 },
    tags: ['workzone', 'occlusion:medium', 'roadside'],
    defaultParams: {},
  },
  {
    id: 'construction.spoil_pile',
    label: 'Spoil pile',
    class: 'construction',
    description:
      'Heap of excavated soil and broken pavement. Low, irregular obstacle that narrows the drivable surface.',
    dims: { l: 2.6, w: 2.55, h: 0.9 },
    tags: ['workzone', 'occlusion:low', 'roadway'],
    defaultParams: { length: 2.5, height: 0.9, seed: 7 },
  },
  {
    id: 'construction.temporary_stop_sign',
    label: 'Temporary stop sign',
    class: 'construction',
    description:
      'Portable octagonal stop sign on a weighted work-zone stand for temporary right-of-way control and alternating one-lane traffic.',
    dims: { l: 0.82, w: 0.92, h: 2.16 },
    tags: ['workzone', 'occlusion:low', 'roadway'],
    defaultParams: {},
  },
  {
    id: 'construction.portable_signal',
    label: 'Portable traffic signal',
    class: 'construction',
    description:
      'Trailer-mounted temporary red/amber/green signal head used to control alternating traffic through a work zone.',
    dims: { l: 1.45, w: 1.2, h: 3.25 },
    tags: ['workzone', 'occlusion:medium', 'roadway'],
    defaultParams: {},
  },
  {
    id: 'construction.long_pipe',
    label: 'Long construction pipe',
    class: 'construction',
    description:
      'Eight-metre utility pipe laid beside or partly across a work zone. A rigid collidable obstacle and low sight-line blocker.',
    dims: { l: 8, w: 0.62, h: 0.62 },
    tags: ['workzone', 'occlusion:low', 'roadway', 'run'],
    defaultParams: { length: 8, diameter: 0.62 },
  },

  // --------------------------------------------------------------- occluders
  {
    id: 'occluder.dumpster',
    label: 'Dumpster',
    class: 'occluder',
    description:
      'Six-yard front-load waste container. Standard kerbside occluder at alley and driveway mouths.',
    dims: { l: 1.9, w: 1.52, h: 1.25 },
    tags: ['occlusion:medium', 'roadside'],
    defaultParams: {},
  },
  {
    id: 'occluder.covered_car',
    label: 'Covered car',
    class: 'occluder',
    description:
      'Car under a fitted cover: a vehicle-sized mass that is deliberately not classifiable as a vehicle model. Long-term parked.',
    dims: { l: 4.58, w: 1.93, h: 1.48 },
    tags: ['occlusion:medium', 'roadside', 'parkable'],
    defaultParams: {},
  },
  {
    id: 'occluder.hedge_run',
    label: 'Hedge run',
    class: 'occluder',
    description:
      'Clipped hedge of parametric length and height along +X. The classic sightline problem on a stop-controlled minor approach.',
    dims: { l: 6.0, w: 0.8, h: 1.2 },
    tags: ['occlusion:high', 'roadside', 'run'],
    defaultParams: { length: 6, height: 1.2 },
  },
  {
    id: 'occluder.fence_run',
    label: 'Chain-link fence run',
    class: 'occluder',
    description:
      'Chain-link fence of parametric length and height along +X. Partially transparent: it degrades detection without hiding outright.',
    dims: { l: 6.0, w: 0.065, h: 1.8 },
    tags: ['occlusion:medium', 'roadside', 'run'],
    defaultParams: { length: 6, height: 1.8 },
  },

  // ------------------------------------------------------------------ street
  {
    id: 'street.mailbox_cluster',
    label: 'Mailbox cluster',
    class: 'street',
    description:
      'Pedestal-mounted cluster mailbox unit with the doors facing +X. Small sidewalk fixture; a reason for pedestrians to stop at a kerb.',
    dims: { l: 0.54, w: 0.98, h: 1.52 },
    tags: ['occlusion:low', 'sidewalk'],
    defaultParams: {},
  },
  {
    id: 'street.bus_shelter',
    label: 'Bus shelter',
    class: 'street',
    description:
      'Glazed transit shelter with a bench, open on the kerb (+Z) side. Hides waiting pedestrians until they step out.',
    dims: { l: 4.0, w: 1.6, h: 2.5 },
    tags: ['occlusion:high', 'sidewalk'],
    defaultParams: {},
  },
  {
    id: 'street.food_cart',
    label: 'Food cart',
    class: 'street',
    description:
      'Sidewalk vending cart with a canopy. Draws a queue of pedestrians onto the kerb and blocks the view down the footway.',
    dims: { l: 1.84, w: 1.0, h: 2.18 },
    tags: ['occlusion:medium', 'sidewalk'],
    defaultParams: {},
  },
  {
    id: 'street.shopping_cart',
    label: 'Shopping cart',
    class: 'street',
    actorClass: 'scooter',
    description:
      'Small rolling wire shopping cart that can enter a roadway from a kerb or parking area and create a low-mass obstacle conflict.',
    dims: { l: 1.05, w: 0.65, h: 1.05 },
    tags: ['debris', 'mobile', 'occlusion:low', 'roadway'],
    defaultParams: {},
  },

  // ----------------------------------------------------------------- hazards
  {
    id: 'hazard.tire_debris',
    label: 'Tyre debris',
    class: 'hazard',
    description:
      'Shredded truck retread lying in the lane. Small dark object that must be classified as drivable-over rather than braked for.',
    dims: { l: 0.74, w: 0.56, h: 0.24 },
    tags: ['debris', 'roadway', 'occlusion:low'],
    defaultParams: {},
  },
  {
    id: 'hazard.cardboard_box',
    label: 'Cardboard box',
    class: 'hazard',
    description:
      'Empty cardboard box with open flaps. The canonical false-positive obstacle: large enough to trigger a brake, light enough to ignore.',
    dims: { l: 0.58, w: 0.44, h: 0.47 },
    tags: ['debris', 'roadway', 'occlusion:low'],
    defaultParams: {},
  },
  {
    id: 'hazard.trash_bags',
    label: 'Refuse sacks',
    class: 'hazard',
    description:
      'Cluster of tied rubbish bags at the kerb. Ambiguous low mass that narrows the usable lane on collection day.',
    dims: { l: 1.02, w: 0.93, h: 0.58 },
    tags: ['debris', 'roadside', 'occlusion:low'],
    defaultParams: { count: 3, seed: 11 },
  },
  {
    id: 'hazard.downed_branch',
    label: 'Downed branch',
    class: 'hazard',
    description:
      'Storm-broken tree limb lying across the lane, with foliage still attached. Irregular, partly drivable, partly not.',
    dims: { l: 2.44, w: 1.2, h: 0.45 },
    tags: ['debris', 'roadway', 'occlusion:low'],
    defaultParams: {},
  },
  {
    id: 'hazard.ladder',
    label: 'Fallen ladder',
    class: 'hazard',
    description:
      'Aluminium extension ladder shed from a roof rack, lying across the carriageway. Long, thin and low: too long to straddle and hard to see at range.',
    dims: { l: 3.55, w: 0.44, h: 0.08 },
    tags: ['debris', 'roadway', 'occlusion:low'],
    defaultParams: {},
  },
  {
    id: 'hazard.mattress',
    label: 'Shed mattress',
    class: 'hazard',
    description:
      'Double mattress lost from a load and lying folded in the lane. Large, soft and completely undrivable-over: it fills a lane despite weighing almost nothing.',
    dims: { l: 1.86, w: 1.32, h: 0.3 },
    tags: ['debris', 'roadway', 'occlusion:low'],
    defaultParams: {},
  },
  {
    id: 'hazard.debris',
    label: 'Unidentified debris',
    class: 'hazard',
    description:
      'Scatter of broken material in the travelled way with no recognisable identity. The generic obstacle for briefs that say "there is debris in the lane" without naming the object.',
    dims: { l: 0.88, w: 0.85, h: 0.24 },
    tags: ['debris', 'roadway', 'occlusion:low'],
    defaultParams: {},
  },
] as const satisfies readonly CatalogEntry[];

/** Every catalog id, as a literal union. */
export type CatalogId = (typeof CATALOG)[number]['id'];

const BY_ID = new Map<string, CatalogEntry>(CATALOG.map((entry) => [entry.id, entry]));

export const CATALOG_IDS = CATALOG.map((entry) => entry.id) as readonly CatalogId[];

/** Canonical choices for new scenarios; compatibility aliases remain in `CATALOG`. */
export const AUTHORING_CATALOG = CATALOG.filter(
  (entry) => !('legacyAliasOf' in entry),
) as readonly CatalogEntry[];

export function isCatalogId(id: string): id is CatalogId {
  return BY_ID.has(id) || EXTERNAL_BY_ID.has(id);
}

/**
 * Author-facing spellings that resolve onto a canonical entry.
 *
 * The catalog files a prop under the class that owns it — a tyre carcass is a
 * `hazard`, a cone is `construction`, a trolley is `street` furniture. An
 * author (or an LLM writing a template) does not know that taxonomy and reaches
 * for the generic `object.` namespace: `object.tyre`, `object.cone`,
 * `object.barrier`. Until now those resolved to nothing, and an unresolved id
 * is the dangerous failure in this system — it does not error, it falls through
 * to a unit cube or, under a `vehicle.` prefix, to a sedan, and the scenario
 * silently stops being about the thing it was about.
 *
 * So this is a vocabulary problem, not a content problem, and the fix is a
 * synonym table rather than a second copy of every prop. Two invariants keep it
 * honest, both asserted in the test suite: an alias may never name an id that
 * does not exist, and an alias may never shadow a canonical id.
 */
export const CATALOG_ALIASES: Readonly<Record<string, CatalogId>> = {
  // Loose objects in the carriageway.
  'object.tyre': 'hazard.tire_debris',
  'object.tire': 'hazard.tire_debris',
  'object.box': 'hazard.cardboard_box',
  'object.cardboard_box': 'hazard.cardboard_box',
  'object.branch': 'hazard.downed_branch',
  'object.trash_bags': 'hazard.trash_bags',
  'object.ladder': 'hazard.ladder',
  'object.mattress': 'hazard.mattress',
  'object.debris': 'hazard.debris',
  'object.shed_load': 'hazard.debris',
  'object.shopping_cart': 'street.shopping_cart',
  // Traffic-management furniture: a work zone is made of these.
  'object.cone': 'construction.traffic_cone',
  'object.traffic_cone': 'construction.traffic_cone',
  'object.barrel': 'construction.channelizer_drum',
  'object.drum': 'construction.channelizer_drum',
  'object.barrier': 'construction.jersey_barrier',
  'object.jersey_barrier': 'construction.jersey_barrier',
  'object.barrier_run': 'construction.jersey_barrier_run',
  'object.barricade': 'construction.barricade_type3',
  'object.pedestrian_barrier': 'construction.pedestrian_barrier',
  'object.sign_board': 'construction.sign_road_work',
  'object.arrow_board': 'construction.arrow_board',
  'object.stop_sign': 'construction.temporary_stop_sign',
  // Animals, under the spellings a brief uses.
  'animal.doe': 'animal.deer',
  'animal.buck': 'animal.deer',
  'animal.stray_dog': 'animal.dog',
} as const;

const EXTERNAL_BY_ID = new Map<string, ExternalCatalogEntry>();
const EXTERNAL_CHANGE_LISTENERS = new Set<() => void>();

function emitExternalCatalogChange(): void {
  for (const listener of EXTERNAL_CHANGE_LISTENERS) listener();
}

function externalBindingsMatch(
  current: ExternalModelBinding,
  next: ExternalModelBinding,
): boolean {
  if (current.kind !== next.kind) return false;
  return current.kind === 'glb' && next.kind === 'glb'
    ? current.contentHash === next.contentHash
    : current.kind === 'proxy' && next.kind === 'proxy' && current.tint === next.tint;
}

/** Register or replace a runtime-backed external entry. */
export function registerExternalCatalogEntry(entry: ExternalCatalogEntry): boolean {
  if (BY_ID.has(entry.id) || Object.hasOwn(CATALOG_ALIASES, entry.id)) {
    throw new Error(`External catalog id shadows a bundled id or alias: ${entry.id}`);
  }
  if (!isExternalCatalogId(entry.id)) {
    throw new Error(
      `External catalog id must start with one of ${EXTERNAL_CATALOG_PREFIXES.map((prefix) => `"${prefix}"`).join(', ')}: ${entry.id}`,
    );
  }

  const current = EXTERNAL_BY_ID.get(entry.id);
  if (current && externalBindingsMatch(current.model, entry.model)) return false;
  EXTERNAL_BY_ID.set(entry.id, entry);
  emitExternalCatalogChange();
  return true;
}

export function unregisterExternalCatalogEntry(id: string): boolean {
  if (!EXTERNAL_BY_ID.delete(id)) return false;
  emitExternalCatalogChange();
  return true;
}

export function clearExternalCatalogEntries(): void {
  if (EXTERNAL_BY_ID.size === 0) return;
  EXTERNAL_BY_ID.clear();
  emitExternalCatalogChange();
}

export function listExternalCatalogEntries(): readonly ExternalCatalogEntry[] {
  return [...EXTERNAL_BY_ID.values()];
}

export function isExternalCatalogId(id: string): boolean {
  return EXTERNAL_CATALOG_PREFIXES.some((prefix) => id.startsWith(prefix));
}

export function externalModelBinding(id: string): ExternalModelBinding | null {
  return EXTERNAL_BY_ID.get(id)?.model ?? null;
}

export function onExternalCatalogChange(listener: () => void): () => void {
  EXTERNAL_CHANGE_LISTENERS.add(listener);
  return () => {
    EXTERNAL_CHANGE_LISTENERS.delete(listener);
  };
}


/**
 * Canonical id for anything an author might write, or `null` if there is no
 * such prop. Callers that resolve assets at author time should treat `null` as
 * an error rather than substituting a default — that substitution is the defect
 * this function exists to prevent.
 */
export function resolveCatalogId(id: string): string | null {
  if (BY_ID.has(id)) return id;
  const alias = CATALOG_ALIASES[id];
  if (alias) return alias;
  return EXTERNAL_BY_ID.has(id) ? id : null;
}

/** Look up an entry, throwing on an unknown id (ids are a hard contract). */
export function getEntry(id: string): CatalogEntry {
  const entry = BY_ID.get(id) ?? EXTERNAL_BY_ID.get(id);
  if (!entry) throw new Error(`Unknown catalog id: ${id}`);
  return entry;
}

/**
 * Resolve actor behavior from catalog metadata, never from an id allowlist.
 * Imported vehicle manifests use the same contract as the built-in catalog.
 */
export function actorClassForCatalogEntry(entry: CatalogEntry): CatalogActorClass {
  if (entry.actorClass) return entry.actorClass;
  switch (entry.class) {
    case 'pedestrian': return 'pedestrian';
    case 'sidewalk_robot': return 'sidewalk_robot';
    case 'drone': return 'drone';
    case 'animal': return 'animal';
    default: return 'static_object';
  }
}

/** Actor classes that may legitimately use this model, including parked use. */
export function actorClassesForCatalogEntry(entry: CatalogEntry): readonly CatalogActorClass[] {
  return [...new Set([
    actorClassForCatalogEntry(entry),
    ...(entry.compatibleActorClasses ?? []),
    'static_object' as const,
  ])];
}

export interface CatalogQuery {
  class?: PropClass | readonly PropClass[];
  /** Entries must carry *every* tag listed. */
  tags?: readonly PropTag[];
}

/** Query the catalog the way an agent would: by class and by tag. */
export function queryCatalog(query: CatalogQuery = {}): CatalogEntry[] {
  const classes = query.class === undefined
    ? undefined
    : Array.isArray(query.class)
      ? (query.class as readonly PropClass[])
      : [query.class as PropClass];
  return CATALOG.filter((entry) => {
    if (classes && !classes.includes(entry.class)) return false;
    if (query.tags && !query.tags.every((tag) => (entry.tags as readonly PropTag[]).includes(tag))) {
      return false;
    }
    return true;
  });
}
