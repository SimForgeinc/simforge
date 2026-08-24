#!/usr/bin/env python3
"""WS6 physics oracle: measured golden-maneuver references from CARLA 0.9.16.

Runs inside the ws6-client sidecar container (network-shared with the CARLA
server). Every maneuver is executed against live vehicle physics; nothing here
is derived from the UniScenarios engine.

Output: results/oracle-*.json — one block per maneuver, plus the CARLA
server/client versions and the exact map/vehicle/dt the numbers were measured
with.
"""

import argparse
import json
import math
import os
import sys
import time

import carla

KMH_TO_MPS = 1 / 3.6
G = 9.80665

# mid-size sedan stand-in for the generic passenger car class
VEHICLE_BLUEPRINT = "vehicle.lincoln.mkz_2020"


def log(msg):
    print(f"[oracle] {msg}", flush=True)


# --------------------------------------------------------------------------- setup

def setup_sync(world, dt):
    settings = world.get_settings()
    settings.synchronous_mode = True
    settings.fixed_delta_seconds = dt
    settings.no_rendering_mode = True  # physics-only oracle; rendering off
    world.apply_settings(settings)


class Runner:
    """Tick loop wrapper owning a freshly-spawnable vehicle."""

    def __init__(self, world, dt, bp_library):
        self.world = world
        self.dt = dt
        self.bp_library = bp_library
        self.vehicle = None

    def respawn(self, transform):
        """Destroy and respawn a fresh vehicle at the transform (starts at rest).
        A fresh actor per maneuver keeps runs independent of prior state."""
        if self.vehicle is not None:
            try:
                if self.vehicle.is_alive:
                    self.vehicle.destroy()
                    self.world.tick()
            except Exception:
                pass
        bp = self.bp_library.find(VEHICLE_BLUEPRINT)
        tf = carla.Transform(
            carla.Location(transform.location.x, transform.location.y,
                           transform.location.z + 0.4),
            transform.rotation)
        v = None
        for _ in range(5):
            v = self.world.try_spawn_actor(bp, tf)
            if v is not None:
                break
            self.world.tick()
        if v is None:
            raise RuntimeError("respawn failed")
        self.vehicle = v
        # settle onto the suspension
        for _ in range(10):
            v.apply_control(control(brake=1.0))
            self.world.tick()

    def tick(self):
        self.world.tick()
        return self.vehicle


def control(throttle=0.0, brake=0.0, steer=0.0):
    return carla.VehicleControl(
        throttle=float(throttle), brake=float(brake),
        steer=float(steer), hand_brake=False, manual_gear_shift=False,
    )


def speed_of(vehicle):
    v = vehicle.get_velocity()
    return math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z)


def yaw_rate_of(vehicle):
    w = vehicle.get_angular_velocity()
    return w.z  # rad/s about world up (flat driving assumption)


def lat_g_of(vehicle):
    return abs(speed_of(vehicle) * yaw_rate_of(vehicle)) / G


def pid_throttle(target_speed_mps, kp=0.08, ki=0.02):
    """Cruise controller returning (throttle, brake) holding target speed."""
    state = {"i": 0.0}

    def ctrl(vehicle):
        err = target_speed_mps - speed_of(vehicle)
        state["i"] = max(-5.0, min(5.0, state["i"] + err))
        out = kp * err + ki * state["i"]
        return (max(0.0, min(1.0, out)), max(0.0, min(1.0, -out)))

    return ctrl


# --------------------------------------------------------------------------- geometry

def world_point(base_loc, yaw, s_forward, l_lateral, z=0.3):
    """Point s_forward metres along yaw, l_lateral metres to the left."""
    x = base_loc.x + s_forward * math.cos(yaw) - l_lateral * math.sin(yaw)
    y = base_loc.y + s_forward * math.sin(yaw) + l_lateral * math.cos(yaw)
    return carla.Location(x=x, y=y, z=z)


def chain_origin_yaw(chain):
    return math.radians(chain[0].transform.rotation.yaw)


def straight_candidates(map_):
    """Junction-free straight chains of lane waypoints, longest first."""
    chains = []
    seen_roads = {}
    for wp in map_.generate_waypoints(5.0):
        key = (wp.road_id, wp.lane_id)
        if key in seen_roads and abs(wp.s - seen_roads[key]) < 40.0:
            continue
        seen_roads[key] = wp.s
        if wp.is_junction:
            continue
        chain = [wp]
        cur = wp
        for _ in range(120):
            nxt = cur.next(5.0)
            if len(nxt) != 1 or nxt[0].is_junction:
                break
            yaw0 = chain[-2].transform.rotation.yaw if len(chain) > 1 else cur.transform.rotation.yaw
            if abs((nxt[0].transform.rotation.yaw - yaw0 + 180) % 360 - 180) > 2.0:
                break
            cur = nxt[0]
            chain.append(cur)
        length = 5.0 * (len(chain) - 1)
        if length >= 100.0:
            chains.append((length, chain))
    chains.sort(key=lambda item: -item[0])
    return chains


def probe_station(world, chain, station_m, bp_library, dt,
                  probe_speed_mps=15.0, probe_s=3.0):
    """Free-roll from one station; True when speed holds and z stays put."""
    yaw = chain_origin_yaw(chain)
    base = chain[0].transform.location
    loc = world_point(base, yaw, station_m, 0.0, z=0.4)
    tf = carla.Transform(loc, carla.Rotation(yaw=math.degrees(yaw)))
    bp = bp_library.find(VEHICLE_BLUEPRINT)
    v = world.try_spawn_actor(bp, tf)
    if v is None:
        return False
    v.set_target_velocity(carla.Vector3D(
        probe_speed_mps * math.cos(yaw), probe_speed_mps * math.sin(yaw), 0.0))
    good = True
    for i in range(int(round(probe_s / dt))):
        v.apply_control(control())
        world.tick()
        vel = v.get_velocity()
        spd = math.sqrt(vel.x * vel.x + vel.y * vel.y)
        # free-fall check only after suspension settle (spawn drop spikes vz)
        if spd < probe_speed_mps - 3.0 or (i > 25 and vel.z < -2.0):
            good = False
    try:
        v.destroy()
    except Exception:
        pass
    for _ in range(3):
        world.tick()
    return good


def chain_clear_window(world, chain, bp_library, dt=0.02, step_m=30.0):
    """Longest contiguous drivable window of the chain as (start_idx, end_idx).

    A falling or blocked probe fails its station; consecutive clear stations
    """
    n = len(chain)
    stations = list(range(0, int(5.0 * (n - 1)), int(step_m)))
    ok = []
    for st in stations:
        good = probe_station(world, chain, st, bp_library, dt)
        log(f"  station {st}: {'clear' if good else 'blocked'}")
        ok.append(good)

    best = None
    i = 0
    while i < len(stations):
        if not ok[i]:
            i += 1
            continue
        j = i
        while j + 1 < len(stations) and ok[j + 1]:
            j += 1
        if best is None or (stations[j] - stations[i]) > (stations[best[1]] - stations[best[0]]):
            best = (i, j)
        i = j + 1

    if best is None:
        return None
    start_station = max(0.0, stations[best[0]] - step_m / 2)
    end_station = min(5.0 * (n - 1), stations[best[1]] + step_m / 2)
    return (int(start_station / 5.0), min(n - 1, int(end_station / 5.0)))


def pick_clear_straight(world, map_, min_len_m=160.0, bp_library=None, dt=0.02):
    """Longest drivable straight: length-ranked candidates, probed and trimmed."""
    for length, chain in straight_candidates(map_):
        if length < min_len_m:
            break
        log(f"probing {length:.0f} m candidate on road {chain[0].road_id}")
        window = chain_clear_window(world, chain, bp_library, dt=dt)
        if window is None:
            continue
        start_i, end_i = window
        win_len = 5.0 * (end_i - start_i)
        if win_len >= min_len_m:
            log(f"clear window: {win_len:.0f} m (waypoints {start_i}..{end_i})")
            return chain[start_i:end_i + 1]
    raise RuntimeError("no clear straight segment found")


# --------------------------------------------------------------------------- run-up

def prepare_speed(runner, chain, target_mps, reserve_m=90.0, start_station_m=0.0):
    """Full-throttle run-up to target_mps on the segment.

    When the road ahead falls short of `reserve_m`, the vehicle is wrapped
    back to `start_station_m` keeping its current speed (set_transform), so
    the run-up continues to accelerate across laps of the segment.

    Raises RuntimeError("vehicle stuck") when full throttle makes no progress,
    so callers can retry from a different station."""
    yaw = chain_origin_yaw(chain)
    base = chain[0].transform.location

    def transform_at(station):
        loc = world_point(base, yaw, station, 0.0, z=0.3)
        return carla.Transform(loc, carla.Rotation(yaw=math.degrees(yaw)))

    def metres_left():
        p = runner.vehicle.get_location()
        last = chain[-1].transform.location
        dx, dy = last.x - p.x, last.y - p.y
        return dx * math.cos(yaw) + dy * math.sin(yaw)

    runner.respawn(transform_at(start_station_m))
    slow_ticks = 0
    for _ in range(int(round(180 / runner.dt))):
        if metres_left() < reserve_m:
            # wrap: teleport back preserving the current speed
            spd = speed_of(runner.vehicle)
            runner.vehicle.set_transform(transform_at(start_station_m))
            runner.tick()
            runner.vehicle.set_target_velocity(carla.Vector3D(
                spd * math.cos(yaw), spd * math.sin(yaw), 0.0))
            runner.tick()
        runner.vehicle.apply_control(control(throttle=1.0))
        runner.tick()
        spd = speed_of(runner.vehicle)
        if spd < 2.0:
            slow_ticks += 1
            if slow_ticks * runner.dt > 4.0:
                raise RuntimeError("vehicle stuck")
        else:
            slow_ticks = 0
        if spd >= target_mps:
            return
    raise RuntimeError("could not reach target speed")


# --------------------------------------------------------------------------- maneuvers

def maneuver_acceleration(runner, results, chain):
    """Full-throttle launch from standstill: time to 100 km/h (+ 60 km/h split)."""
    yaw = chain_origin_yaw(chain)

    base = chain[0].transform.location

    def transform_at(station):
        loc = world_point(base, yaw, station, 0.0, z=0.3)
        return carla.Transform(loc, carla.Rotation(yaw=math.degrees(yaw)))

    def metres_left():
        p = runner.vehicle.get_location()
        last = chain[-1].transform.location
        dx, dy = last.x - p.x, last.y - p.y
        return dx * math.cos(yaw) + dy * math.sin(yaw)

    runner.respawn(transform_at(0.0))

    t100 = None
    t60 = None
    clock = 0.0
    steps = int(round(40 / runner.dt))
    for i in range(steps):
        if metres_left() < 40.0:
            # restart the launch from the segment start (fresh standstill run)
            prepare_speed(runner, chain, 0.01, reserve_m=10_000.0)
            clock = 0.0
            t60 = None
        runner.vehicle.apply_control(control(throttle=1.0))
        runner.tick()
        clock += runner.dt
        spd = speed_of(runner.vehicle)
        if t60 is None and spd >= 60 * KMH_TO_MPS:
            t60 = clock
        if spd >= 100 * KMH_TO_MPS:
            t100 = clock
            break

    if t100 is None:
        raise RuntimeError("vehicle never reached 100 km/h")
    results["acceleration"] = {
        "metric": "zeroTo100kmhTimeS",
        "value": round(t100, 3),
        "zeroTo60kmhTimeS": round(t60, 3) if t60 else None,
        "note": "full-throttle launch from standstill, automatic gearbox",
    }


def maneuver_braking(runner, results, chain):
    """Full service brake 100 -> 0 km/h: stopping distance and mean deceleration."""
    prepare_speed(runner, chain, 100 * KMH_TO_MPS)

    v = runner.vehicle
    v0 = speed_of(v)
    dist = 0.0
    prev = v0
    t_stop = 0.0
    peak_decel = 0.0
    for _ in range(int(round(20 / runner.dt))):
        v.apply_control(control(brake=1.0))
        runner.tick()
        t_stop += runner.dt
        s = speed_of(v)
        dist += prev * runner.dt
        peak_decel = max(peak_decel, (prev - s) / runner.dt)
        prev = s
        if s <= 0.05:
            break

    results["braking_100_to_0"] = {
        "metric": "stoppingDistanceM",
        "value": round(dist, 2),
        "entrySpeedKmh": round(v0 * 3.6, 2),
        "stopTimeS": round(t_stop, 3),
        "meanDecelMps2": round((v0 * v0) / (2 * dist), 2) if dist > 0 else None,
        "note": "full-throttle run-up, pedal applied the moment v first reaches "
                "100 km/h; distance integrated from pedal onset",
    }


def maneuver_coastdown(runner, results, chain):
    """Pedals released from 100 km/h (automatic gearbox in drive): deceleration
    sampled at the 80 km/h crossing. NOTE: CARLA's coast includes powertrain
    drag; the SAE J1263 published figure is a neutral road-load coast. The
    protocol gap is documented in docs/physics-provenance.md."""
    prepare_speed(runner, chain, 100 * KMH_TO_MPS, reserve_m=140.0)
    v = runner.vehicle
    v.apply_control(control())
    runner.tick()

    prev = speed_of(v)
    for _ in range(int(round(90 / runner.dt))):
        v.apply_control(control())
        runner.tick()
        s = speed_of(v)
        if s <= 80 * KMH_TO_MPS:
            decel = (prev - s) / runner.dt
            results["coastdown_80"] = {
                "metric": "coastdownDecelAt80kmhMps2",
                "value": round(decel, 3),
                "crossingSpeedKmh": round(s * 3.6, 2),
                "note": "pedals released, automatic gearbox in drive "
                        "(includes CARLA powertrain drag)",
            }
            return
        prev = s
    raise RuntimeError("never coasted down to 80 km/h")


def maneuver_step_steer(runner, results, chain):
    """Step-steer at 50 km/h: steady-state yaw gain from small steer steps.
    Speed kept low enough that even the largest step holds the lane through
    the sampling window. Runs exceeding the stability envelope (sideslip >
    0.26 rad or lateral g > 0.6, i.e. at-the-limit or spinning) are discarded."""
    target = 50 * KMH_TO_MPS
    gains = []
    used_cmds = []
    peak_latg_overall = 0.0
    attempts = []
    for steer_cmd in (0.04, 0.06, 0.08):
        for offset in (5.0, 30.0, 55.0):
            try:
                # reserve covers only the maneuver itself: reaching 50 km/h
                # needs <100 m on this segment, so no speed-preserving wrap
                prepare_speed(runner, chain, target, reserve_m=60.0,
                              start_station_m=offset)
                break
            except RuntimeError as exc:
                if "stuck" not in str(exc):
                    raise
        else:
            raise RuntimeError("could not reach target speed")
        cruise = pid_throttle(target)
        # settle onto cruise hold before the step input
        stable_settle = True
        for _ in range(int(round(1.0 / runner.dt))):
            thr, brk = cruise(runner.vehicle)
            runner.vehicle.apply_control(control(thr, brk))
            runner.tick()
        v0 = runner.vehicle
        vel_w = v0.get_velocity()
        vyaw0 = math.radians(v0.get_transform().rotation.yaw)
        v_lat0 = -vel_w.x * math.sin(vyaw0) + vel_w.y * math.cos(vyaw0)
        if abs(math.atan2(v_lat0, abs(vel_w.x * math.cos(vyaw0) + vel_w.y * math.sin(vyaw0)) + 1e-6)) > 0.15 \
                or speed_of(v0) < target - 2.0:
            attempts.append({"steerCmd": steer_cmd, "discardedAt": "settle",
                             "sideslipRad": round(abs(math.atan2(v_lat0, 1e-6)), 3),
                             "speedKmh": round(speed_of(v0) * 3.6, 1)})
            continue

        yaw_samples = []
        latg_peak = 0.0
        sideslip_peak = 0.0
        settle_s, sample_s = 0.5, 1.5
        steps = int(round((settle_s + sample_s) / runner.dt))
        for i in range(steps):
            v = runner.vehicle
            thr, brk = cruise(v)
            v.apply_control(control(thr, brk, steer_cmd))
            runner.tick()
            latg = lat_g_of(v)
            latg_peak = max(latg_peak, latg)
            vel_w = v.get_velocity()
            vyaw = math.radians(v.get_transform().rotation.yaw)
            v_long = vel_w.x * math.cos(vyaw) + vel_w.y * math.sin(vyaw)
            v_lat = -vel_w.x * math.sin(vyaw) + vel_w.y * math.cos(vyaw)
            sideslip_peak = max(sideslip_peak,
                                abs(math.atan2(v_lat, abs(v_long) + 1e-6)))
            if i * runner.dt >= settle_s:
                yaw_samples.append(yaw_rate_of(v))
        peak_latg_overall = max(peak_latg_overall, latg_peak)
        stable = sideslip_peak <= 0.26 and latg_peak <= 0.6
        attempts.append({
            "steerCmd": steer_cmd,
            "sideslipPeakRad": round(sideslip_peak, 3),
            "latgPeak": round(latg_peak, 3),
            "yawSamples": len(yaw_samples),
            "stable": stable,
        })
        if yaw_samples and stable:
            gains.append((sum(yaw_samples) / len(yaw_samples)) / steer_cmd)
            used_cmds.append(steer_cmd)

    if not gains:
        raise RuntimeError(f"no stable step-steer run; attempts={attempts}")
    results["step_steer"] = {
        "attempts": attempts,
        "steadyYawRatePerNormSteerRadps": round(sum(gains) / len(gains), 4),
        "peakLateralG": round(peak_latg_overall, 3),
        "speedKmh": 50,
        "settleS": 0.5,
        "sampleS": 1.5,
        "note": "normalized steer command; yaw gain averaged over stable, "
                "unsaturated steps (sideslip<=0.26 rad, lateral<=0.6 g)",
    }




# --- double lane change (ISO 3888-1) -----------------------------------------------

def iso3888_course(base_loc, yaw, vehicle_width_m=1.94):
    """ISO 3888-1:2002 double lane-change course as a polyline + gate stations.

      S1  15 m  w1 = 1.1 + B/2      (entry lane)
      S2  30 m  w2 = B + 1          (shift section)
      S3  25 m  w3 = 1.1 + B/2      (second lane straight)
      S4  25 m  w4 = B + 1          (shift back section)
      S5  30 m  w5 = 1.1 + B/2      (exit lane)
    Lateral lane offset: 3.5 m.
    """
    b = vehicle_width_m
    widths = [1.1 + b / 2, b + 1.0, 1.1 + b / 2, b + 1.0, 1.1 + b / 2]
    offset = 3.5
    s1, s2, s3, s4, s5 = 15.0, 45.0, 70.0, 95.0, 125.0
    centreline = [
        (0.0, 0.0),
        (s1, 0.0),
        (s2, offset),
        (s3, offset),
        (s4, 0.0),
        (s5, 0.0),
    ]

    def centre_at(x):
        for (x0, l0), (x1, l1) in zip(centreline, centreline[1:]):
            if x0 <= x <= x1:
                return l0 + (l1 - l0) * (x - x0) / (x1 - x0)
        return 0.0

    path = [world_point(base_loc, yaw, x, centre_at(x)) for x in range(0, 126, 5)]
    gates = [
        {"name": "A", "station": 0.0, "width": widths[0]},
        {"name": "B", "station": s1, "width": widths[1]},
        {"name": "C", "station": s2, "width": widths[2]},
        {"name": "D", "station": s3, "width": widths[3]},
        {"name": "E", "station": s4, "width": widths[4]},
        {"name": "F", "station": s5, "width": widths[4]},
    ]
    return path, gates, centre_at


def maneuver_dlc(runner, results, map_, chain, entry_kmh=70.0, vehicle_width_m=1.94):
    """ISO 3888-1 double lane change at the given entry speed."""
    # lay the course 45 m into the probed window so the 35 m run-in stays
# on verified-clear road
    base = world_point(chain[0].transform.location, chain_origin_yaw(chain), 45.0, 0.0,
                       z=chain[0].transform.location.z)
    yaw = chain_origin_yaw(chain)
    path, gates, centre_at = iso3888_course(base, yaw, vehicle_width_m)

    entry = entry_kmh * KMH_TO_MPS
    exit_station = 130.0

    # fresh vehicle 35 m before gate A; full-throttle run-in to entry speed
    def transform_at(station):
        loc = world_point(base, yaw, station, 0.0, z=0.3)
        return carla.Transform(loc, carla.Rotation(yaw=math.degrees(yaw)))

    runner.respawn(transform_at(-35.0))
    v = runner.vehicle
    reached_entry = False
    for _ in range(int(round(12 / runner.dt))):
        p = v.get_location()
        dx, dy = p.x - base.x, p.y - base.y
        s_now = dx * math.cos(yaw) + dy * math.sin(yaw)
        if s_now >= -2.0:
            break
        v.apply_control(control(throttle=1.0))
        runner.tick()
        if speed_of(v) >= entry:
            reached_entry = True
            break

    traj = []

    def sample(vehicle, t):
        p = vehicle.get_location()
        dx, dy = p.x - base.x, p.y - base.y
        s = dx * math.cos(yaw) + dy * math.sin(yaw)
        l = -dx * math.sin(yaw) + dy * math.cos(yaw)
        rec = {"t": round(t, 3), "s": round(s, 2), "l": round(l, 2),
               "v": round(speed_of(vehicle), 2),
               "latG": round(lat_g_of(vehicle), 3)}
        traj.append(rec)
        return rec

    finished = {"done": False}
    lookahead = 12.0
    idx = {"i": 0}
    steps = int(round(15 / runner.dt))
    cruise_exit = pid_throttle(entry)
    for i in range(steps):
        loc = v.get_location()
        p_dx, p_dy = loc.x - base.x, loc.y - base.y
        s_now = p_dx * math.cos(yaw) + p_dy * math.sin(yaw)
        if s_now >= exit_station:
            finished["done"] = True
            break
        while idx["i"] < len(path) - 1:
            a = path[idx["i"]]
            if (a.x - loc.x) ** 2 + (a.y - loc.y) ** 2 < lookahead ** 2:
                idx["i"] += 1
            else:
                break
        target = path[min(idx["i"], len(path) - 1)]
        thr, brk = cruise_exit(v)
        vyaw = math.radians(v.get_transform().rotation.yaw)
        alpha = math.atan2(target.y - loc.y, target.x - loc.x) - vyaw
        alpha = (alpha + math.pi) % (2 * math.pi) - math.pi
        steer = max(-1.0, min(1.0, math.atan2(2.9 * 2 * math.sin(alpha), lookahead) / 0.6))
        v.apply_control(control(thr, brk, steer))
        runner.tick()
        sample(v, (i + 1) * runner.dt)

    # evaluate gate crossings
    gate_hits = []
    peak_latg = 0.0
    exit_speed = None
    for g in gates:
        hits = [r for r in traj if r["s"] >= g["station"]]
        if not hits:
            continue
        r = hits[0]
        half = g["width"] / 2
        centre = centre_at(min(g["station"], 125.0))
        gate_hits.append({
            "gate": g["name"],
            "lateralM": r["l"],
            "centreM": round(centre, 2),
            "withinWidth": abs(r["l"] - centre) <= half,
        })
    for r in traj:
        peak_latg = max(peak_latg, r["latG"])
    if traj:
        exit_speed = traj[-1]["v"]
    passed = bool(gate_hits) and all(h["withinWidth"] for h in gate_hits) \
        and finished["done"] and reached_entry

    results["double_lane_change_iso3888"] = {
        "metrics": ["peakLateralG", "exitSpeedMps"],
        "entrySpeedKmh": entry_kmh,
        "entrySpeedReached": reached_entry,
        "passed": passed,
        "peakLateralG": round(peak_latg, 3),
        "exitSpeedMps": exit_speed,
        "gates": gate_hits,
        "courseCompleted": finished["done"],
        "vehicleWidthM": vehicle_width_m,
        "note": "ISO 3888-1 course 15/30/25/25/30 m, widths 1.1+B/2 and B+1, "
                "lane offset 3.5 m; pure-pursuit follower pinned to entry speed",
    }


# --- steady-state cornering (skidpad) ------------------------------------------------

def find_roundabout_loop(map_):
    """Waypoints forming a roundabout loop, for constant-radius cornering."""
    seen_junctions = set()
    for wp_start, _wp_end in map_.get_topology():
        if not wp_start.is_junction:
            continue
        junction = wp_start.get_junction()
        if junction.id in seen_junctions:
            continue
        seen_junctions.add(junction.id)
        loop = [wp_start]
        cur = wp_start
        closed = False
        for _ in range(150):
            nxt = cur.next(3.0)
            if not nxt:
                break
            cur = nxt[0]
            if cur.transform.location.distance(wp_start.transform.location) < 4.0 \
                    and len(loop) > 10:
                loop.append(cur)
                closed = True
                break
            loop.append(cur)
        # a long open arc still supports sustained-cornering measurement
        if len(loop) >= 40:
            return loop
    return None


def maneuver_skidpad(runner, results, map_):
    """Constant-radius steady-state cornering: max sustained lateral g.

    Follows a roundabout lane at increasing speeds; the reported value is the
    highest mean |v*yaw_rate| held for a settled window without leaving the
    lane."""
    loop = find_roundabout_loop(map_)
    if loop is None:
        raise RuntimeError("no roundabout loop found on this map")
    log(f"roundabout loop: {len(loop)} waypoints")

    speeds_kmh = [24, 32, 40, 48, 56, 64]
    best = {"latG": 0.0, "speedKmh": None}
    per_speed = []
    radius_est = None

    for kmh in speeds_kmh:
        target = kmh * KMH_TO_MPS
        start_wp = loop[0]
        tf = carla.Transform(start_wp.transform.location, start_wp.transform.rotation)
        try:
            runner.respawn(tf)
        except RuntimeError as exc:
            per_speed.append({"targetKmh": kmh, "error": "spawn failed"})
            continue
        v = runner.vehicle
        cruise = pid_throttle(target)

        latgs = []
        yaw_rates = []
        speeds = []
        progress = 0.0
        departed = False
        anchor_idx = 0
        lap_steps = int(round(40 / runner.dt))
        for i in range(lap_steps):
            loc = v.get_location()
            while anchor_idx < len(loop) - 1 and \
                    loop[anchor_idx].transform.location.distance(loc) < 6.0:
                anchor_idx += 1
            tgt_wp = loop[min(anchor_idx, len(loop) - 1)]
            thr, brk = cruise(v)
            vyaw = math.radians(v.get_transform().rotation.yaw)
            tl = tgt_wp.transform.location
            alpha = math.atan2(tl.y - loc.y, tl.x - loc.x) - vyaw
            alpha = (alpha + math.pi) % (2 * math.pi) - math.pi
            steer = max(-1.0, min(1.0, math.atan2(2.9 * 2 * math.sin(alpha), 6.0) / 0.6))
            v.apply_control(control(thr, brk, steer))
            runner.tick()

            near = map_.get_waypoint(loc)
            dev = loc.distance(near.transform.location) if near else 999.0
            progress += runner.dt
            if dev > 2.5:
                departed = True
                break
            if progress >= 8.0:  # settled samples only
                latgs.append(lat_g_of(v))
                yaw_rates.append(abs(yaw_rate_of(v)))
                speeds.append(speed_of(v))
            if progress >= 25.0:
                break

        if latgs:
            mean_latg = sum(latgs) / len(latgs)
            mean_v = sum(speeds) / len(speeds)
            mean_yaw = sum(yaw_rates) / len(yaw_rates)
            r = mean_v / mean_yaw if mean_yaw > 1e-4 else None
            if radius_est is None and r:
                radius_est = r
            per_speed.append({
                "targetKmh": kmh, "meanLatG": round(mean_latg, 3),
                "meanSpeedKmh": round(mean_v * 3.6, 1),
                "radiusM": round(r, 1) if r else None,
                "departedLane": departed,
                "samples": len(latgs),
            })
            if not departed and mean_latg > best["latG"]:
                best = {"latG": round(mean_latg, 3), "speedKmh": kmh}

    results["steady_state_cornering"] = {
        "metrics": ["maxSustainedLateralG", "corneringRadiusM"],
        "value": best["latG"],
        "atSpeedKmh": best["speedKmh"],
        "corneringRadiusM": round(radius_est, 1) if radius_est else None,
        "perSpeed": per_speed,
        "method": "roundabout lane-follow at increasing speed; mean |v*yaw_rate| "
                  "over settled windows without lane departure",
    }


# --------------------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=2000)
    ap.add_argument("--dt", type=float, default=0.02)
    ap.add_argument("--map", default=None, help="load this map first (e.g. Town03_Opt)")
    ap.add_argument("--maneuvers",
                    default="acceleration,braking,coastdown,step_steer,dlc,skidpad")
    ap.add_argument("--out", default="results/oracle-results.json")
    args = ap.parse_args()

    client = carla.Client(args.host, args.port)
    client.set_timeout(300.0)
    server_version = client.get_server_version()
    client_version = client.get_client_version()
    log(f"server {server_version}, client {client_version}")

    if args.map:
        log(f"loading map {args.map}")
        world = client.load_world(args.map)
    else:
        world = client.get_world()
    map_name = world.get_map().name
    log(f"map {map_name}")

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    results = {
        "schema": "uniscenarios.physics-oracle-run/v1",
        "carlaServerVersion": server_version,
        "carlaClientVersion": client_version,
        "map": map_name,
        "vehicleBlueprint": VEHICLE_BLUEPRINT,
        "fixedDeltaSeconds": args.dt,
        "generatedAtEpochS": int(time.time()),
        "results": {},
        "errors": {},
    }

    wanted = [m.strip() for m in args.maneuvers.split(",") if m.strip()]
    bp_library = world.get_blueprint_library()
    vehicle_holder = {"actor": None}

    def guarded(key, fn):
        try:
            fn()
            log(f"{key}: {json.dumps(results['results'].get(key), default=str)[:300]}")
        except Exception as e:
            results["errors"][key] = repr(e)
            log(f"ERROR {key}: {e!r}")

    try:
        setup_sync(world, args.dt)
        # dedicated server: clear leftovers from previous sessions
        for av in world.get_actors().filter("vehicle.*"):
            try:
                av.destroy()
            except Exception:
                pass
        for _ in range(5):
            world.tick()

        runner = Runner(world, args.dt, bp_library)

        needs_straight = any(m in wanted for m in
                             ("acceleration", "braking", "coastdown", "step_steer", "dlc"))
        chain = None
        if needs_straight:
            chain = pick_clear_straight(world, world.get_map(),
                                        bp_library=bp_library, dt=args.dt)

        if "acceleration" in wanted:
            guarded("acceleration",
                    lambda: maneuver_acceleration(runner, results["results"], chain))
        if "braking" in wanted:
            guarded("braking_100_to_0",
                    lambda: maneuver_braking(runner, results["results"], chain))
        if "coastdown" in wanted:
            guarded("coastdown_80",
                    lambda: maneuver_coastdown(runner, results["results"], chain))
        if "step_steer" in wanted:
            guarded("step_steer",
                    lambda: maneuver_step_steer(runner, results["results"], chain))
        if "dlc" in wanted:
            for speed in (40.0, 55.0):
                before = dict(results["results"])
                guarded("double_lane_change_iso3888",
                        lambda s=speed: maneuver_dlc(runner, results["results"],
                                                     world.get_map(), chain, entry_kmh=s))
                res = results["results"].get("double_lane_change_iso3888", {})
                if res and res not in (before.get("double_lane_change_iso3888"),) \
                        and (res.get("passed") or speed == 50.0):
                    break
        if "skidpad" in wanted:
            guarded("steady_state_cornering",
                    lambda: maneuver_skidpad(runner, results["results"], world.get_map()))

    finally:
        settings = world.get_settings()
        settings.synchronous_mode = False
        settings.no_rendering_mode = False
        world.apply_settings(settings)
        if vehicle_holder["actor"] is not None:
            pass
        for av in world.get_actors().filter("vehicle.*"):
            try:
                av.destroy()
            except Exception:
                pass

    with open(args.out, "w") as f:
        json.dump(results, f, indent=2)
    log(f"wrote {args.out}")
    return 0 if not results["errors"] else 1


if __name__ == "__main__":
    sys.exit(main())
