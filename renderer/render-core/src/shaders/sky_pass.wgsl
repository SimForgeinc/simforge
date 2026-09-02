// Stars, Moon and volumetric cloud deck, composited *over* the atmosphere's
// own sky after the main pass (premultiplied "over" blend; see sky_pass.rs).
//
// Layers, in the order light physically reaches the camera:
//   1. NASA/SVS Deep Star Maps 2020 plate, sampled through the epoch-corrected
//      equatorial->horizon rotation. Resolved stars and the Milky Way both
//      live in the plate, so their relative photometry is the catalogue's.
//   2. Analytic lunar disc at the resolved topocentric angular radius, with
//      the LROC albedo map, optical libration, and a Lommel-Seeliger
//      terminator.
//   3. Raymarched cloud shell (24-64 steps) with a multi-octave 3D density
//      field, lit by the same Sun and Moon the scene uses, by the sky above
//      and by the ground below. Its transmittance attenuates layers 1-2 and
//      the atmosphere sky already in the target.
//   4. Urban skyglow, added after the clouds because it is scattered by the
//      air *between* the observer and the deck.
//
// Output: rgb = radiance this pass adds (already exposed), a = 1 - weight the
// existing target keeps. The blend state turns that into
// `src.rgb + dst.rgb * (1 - src.a)`.

#import bevy_core_pipeline::fullscreen_vertex_shader::FullscreenVertexOutput

struct Sky {
    world_from_clip: mat4x4<f32>,
    equ_from_world: mat4x4<f32>,
    camera: vec4<f32>,        // xyz world position, w altitude above the reference sphere
    moon: vec4<f32>,          // xyz direction, w angular radius (rad)
    moon_north: vec4<f32>,    // xyz lunar rotation axis, w sub-earth longitude (rad)
    moon_sun: vec4<f32>,      // xyz Moon->Sun direction, w sub-earth latitude (rad)
    sun: vec4<f32>,           // xyz direction, w illuminance (lx) reaching the deck top
    sun_tint: vec4<f32>,      // rgb beam chromaticity at the deck, w ground bounce luminance (cd/m2)
    sky_ambient: vec4<f32>,   // rgb sky radiance lighting the deck top (cd/m2), w aerosol scale height (m)
    skyglow: vec4<f32>,       // rgb chromaticity, w zenith-referenced luminance (cd/m2)
    p0: vec4<f32>,            // scene exposure, star gain, moon disc gain, radians per pixel
    p1: vec4<f32>,            // cloud cover, density, elapsed seconds, cloud type
    p2: vec4<f32>,            // wind x, wind z, base m, top m
    p3: vec4<f32>,            // march steps, light steps, debug mode, moon illuminance (lx)
    p4: vec4<f32>,            // sky exposure, Rayleigh beta (1/m), Rayleigh scale height (m), aerosol beta (1/m)
    p5: vec4<f32>,            // night lift (moon/city-lit cloud; stars and skyglow carry it already), -, -, -
}

@group(0) @binding(0) var<uniform> sky: Sky;
@group(0) @binding(1) var star_plate: texture_2d<f32>;
@group(0) @binding(2) var moon_plate: texture_2d<f32>;
@group(0) @binding(3) var cloud_shape: texture_3d<f32>;
@group(0) @binding(4) var cloud_detail: texture_3d<f32>;
@group(0) @binding(5) var plate_sampler: sampler;
@group(0) @binding(6) var volume_sampler: sampler;
// Fit of the dilated base's column-max CDF; mirrors clouds.rs.
const BASE_LOW: f32 = 0.668;
const BASE_HIGH: f32 = 0.94;

const PI: f32 = 3.14159265359;
const EARTH_R: f32 = 6371000.0;
const CLOUD_TILE_M: f32 = 26000.0;
const DETAIL_TILE_M: f32 = 1300.0;
const MAX_CLOUD_DIST: f32 = 140000.0;

fn sat(x: f32) -> f32 { return clamp(x, 0.0, 1.0); }

fn remap(v: f32, lo: f32, hi: f32, to_lo: f32, to_hi: f32) -> f32 {
    return to_lo + (v - lo) / max(hi - lo, 1e-6) * (to_hi - to_lo);
}

// ---------------------------------------------------------------- celestial

fn star_radiance(dir_ws: vec3<f32>) -> vec3<f32> {
    let equ = (sky.equ_from_world * vec4<f32>(dir_ws, 0.0)).xyz;
    let ra = atan2(equ.y, equ.x);
    let dec = asin(clamp(equ.z, -1.0, 1.0));
    let uv = vec2<f32>(fract(0.5 - ra / (2.0 * PI)), 0.5 - dec / PI);
    return textureSampleLevel(star_plate, plate_sampler, uv, 0.0).rgb * sky.p0.y;
}

// Lommel-Seeliger reflectance, the standard first-order model for the
// Moon's regolith: R = mu_i / (mu_i + mu_e).
fn lunar_reflectance(mu_i: f32, mu_e: f32) -> f32 {
    if mu_i <= 0.0 { return 0.0; }
    return mu_i / max(mu_i + mu_e, 1e-4);
}

fn moon_radiance(dir_ws: vec3<f32>) -> vec3<f32> {
    let centre = sky.moon.xyz;
    let rho = sky.moon.w;
    let cos_sep = dot(dir_ws, centre);
    if cos_sep < cos(rho * 3.0) {
        return vec3<f32>(0.0);
    }
    let sep = acos(clamp(cos_sep, -1.0, 1.0));

    // Disc frame: lunar north projected onto the sky plane gives the position
    // angle, so maria and the terminator sit at the right roll.
    let north = normalize(sky.moon_north.xyz);
    var up = north - centre * dot(north, centre);
    if length(up) < 1e-5 { up = vec3<f32>(0.0, 1.0, 0.0) - centre * centre.y; }
    up = normalize(up);
    let right = normalize(cross(centre, up));

    let sin_rho = sin(rho);
    let x = dot(dir_ws, right) / sin_rho;
    let y = dot(dir_ws, up) / sin_rho;
    let r2 = x * x + y * y;

    // One-pixel coverage term keeps the limb from stair-stepping at the
    // ~11 px the disc spans at 1280x720.
    let coverage = sat((rho - sep) / max(sky.p0.w, 1e-6) + 0.5);
    if coverage <= 0.0 || r2 >= 1.0 {
        return vec3<f32>(0.0);
    }
    let z = sqrt(max(1.0 - r2, 0.0));
    let normal = x * right + y * up - z * centre;

    // Selenographic basis from the sub-Earth libration point.
    let to_earth = -centre;
    var e = to_earth - north * dot(to_earth, north);
    if length(e) < 1e-5 { e = right; }
    e = normalize(e);
    let f = cross(north, e);
    let sub_lon = sky.moon_north.w;
    let x_body = e * cos(sub_lon) - f * sin(sub_lon);
    let y_body = e * sin(sub_lon) + f * cos(sub_lon);

    let lat = asin(clamp(dot(normal, north), -1.0, 1.0));
    let lon = atan2(dot(normal, y_body), dot(normal, x_body));
    let uv = vec2<f32>(0.5 + lon / (2.0 * PI), 0.5 - lat / PI);
    let albedo = textureSampleLevel(moon_plate, plate_sampler, uv, 0.0).rgb;

    let sun_dir = normalize(sky.moon_sun.xyz);
    let mu_i = dot(normal, sun_dir);
    let mu_e = z;
    // Soften the terminator across roughly one lunar-surface pixel so the
    // phase boundary reads as a curve, not a jagged step.
    let lit = sat(mu_i / 0.03 + 0.5);
    let refl = lunar_reflectance(max(mu_i, 0.0), mu_e) * lit;
    // Earthshine on the night side: ~1/10000 of the sunlit surface, brightest
    // near new Moon.
    let ashen = 0.0018 * (1.0 - sat(dot(sky.moon.xyz, sun_dir)));
    return albedo * (refl + ashen) * sky.p0.z * coverage;
}

// -------------------------------------------------------------------- cloud

fn height_fraction(altitude: f32) -> f32 {
    return sat((altitude - sky.p2.z) / max(sky.p2.w - sky.p2.z, 1.0));
}

fn density_gradient(h: f32, kind: f32) -> f32 {
    let stratus = sat(remap(h, 0.0, 0.10, 0.0, 1.0)) * sat(remap(h, 0.16, 0.34, 1.0, 0.0));
    let stratocu = sat(remap(h, 0.0, 0.16, 0.0, 1.0)) * sat(remap(h, 0.42, 0.72, 1.0, 0.0));
    let cumulus = sat(remap(h, 0.02, 0.26, 0.0, 1.0)) * sat(remap(h, 0.58, 1.0, 1.0, 0.0));
    let low = mix(stratus, stratocu, sat(kind * 2.0));
    return mix(low, cumulus, sat(kind * 2.0 - 1.0));
}

fn cloud_density(p_world: vec3<f32>, altitude: f32, cheap: bool) -> f32 {
    let h = height_fraction(altitude);
    if h <= 0.0 || h >= 1.0 { return 0.0; }
    let wind = vec3<f32>(sky.p2.x, 0.0, sky.p2.y) * sky.p1.z;
    // The deck also creeps upward slowly, which stops the field from looking
    // like a flat texture sliding past.
    let p = p_world + wind + vec3<f32>(0.0, sky.p1.z * 0.12, 0.0);
    let uvw = p / CLOUD_TILE_M;
    let shape = textureSampleLevel(cloud_shape, volume_sampler, uvw, 0.0);
    // Second lookup at an incommensurate scale and offset: the 26 km lattice
    // never lines up with itself inside the visible dome.
    let modulation = textureSampleLevel(
        cloud_shape, volume_sampler,
        uvw * 0.4237 + vec3<f32>(0.317, 0.113, 0.731), 0.0
    ).r;

    let billow = shape.g * 0.625 + shape.b * 0.25 + shape.a * 0.125;
    // Perlin-Worley dilation compresses the base; smoothstep over its
    // measured column-max band is the CDF fit that makes cover a linear
    // threshold. Mirrors clouds.rs exactly.
    let dilated = sat(remap(shape.r, billow - 1.0, 1.0, 0.0, 1.0));
    let base = smoothstep(BASE_LOW, BASE_HIGH, dilated) * density_gradient(h, sky.p1.w);
    let cover = sat(sky.p1.x * (0.75 + 0.5 * modulation));
    var d = sat(remap(base, 1.0 - cover, 1.0, 0.0, 1.0));
    if d <= 0.0 { return 0.0; }

    if !cheap {
        let det = textureSampleLevel(cloud_detail, volume_sampler, p / DETAIL_TILE_M, 0.0);
        let erode = det.r * 0.625 + det.g * 0.25 + det.b * 0.125;
        // Erode only where the field is already thin: cores stay solid,
        // edges break into wisps.
        let edge = 1.0 - sat(d * 3.0);
        d = sat(remap(d, erode * 0.55 * edge, 1.0, 0.0, 1.0));
    }
    return d * sky.p1.y;
}

fn hg(cos_theta: f32, g: f32) -> f32 {
    let g2 = g * g;
    return (1.0 - g2) / (4.0 * PI * pow(1.0 + g2 - 2.0 * g * cos_theta, 1.5));
}

fn dual_lobe(cos_theta: f32) -> f32 {
    return mix(hg(cos_theta, 0.82), hg(cos_theta, -0.28), 0.35);
}

// Exit distance of a ray starting inside a sphere of radius `r` centred on
// the origin. Returns -1 when the ray never reaches it.
fn sphere_exit(origin: vec3<f32>, dir: vec3<f32>, r: f32) -> f32 {
    let b = dot(origin, dir);
    let c = dot(origin, origin) - r * r;
    let disc = b * b - c;
    if disc < 0.0 { return -1.0; }
    return -b + sqrt(disc);
}

fn light_transmittance(p_world: vec3<f32>, altitude: f32, l: vec3<f32>, steps: i32) -> f32 {
    var tau = 0.0;
    var t = 0.0;
    var step = 90.0;
    for (var i = 0; i < steps; i = i + 1) {
        t = t + step;
        let q = p_world + l * t;
        let alt = altitude + l.y * t;
        tau = tau + cloud_density(q, alt, true) * step;
        step = step * 1.65;
    }
    return tau;
}

// Wrenninge multi-scatter octaves: three progressively broader, dimmer lobes
// stand in for higher-order scattering so cloud interiors are grey, not
// black, plus a fourth, nearly isotropic, very slowly extinguished term for
// the diffuse transmission that lights the base of a thick deck: a 1 km
// cumulus still passes ~30% of the beam as diffuse light (two-stream,
// tau ~ 20), which the first three octaves cannot reach.
fn multi_scatter(tau: f32, cos_theta: f32) -> f32 {
    var energy = 0.0;
    var a = 1.0;
    var b = 1.0;
    var c = 1.0;
    for (var o = 0; o < 3; o = o + 1) {
        energy = energy + a * exp(-tau * b) * dual_lobe(cos_theta * c);
        a = a * 0.52;
        b = b * 0.46;
        c = c * 0.68;
    }
    energy = energy + 0.9 * exp(-tau * 0.04) * hg(cos_theta * 0.3, 0.3);
    return energy;
}

struct CloudResult {
    // Radiance from Sun- and sky-lit cloud (cd/m2): exposed with the sky.
    day: vec3<f32>,
    // Radiance from Moon- and city-lit cloud (cd/m2): exposed with the scene.
    night: vec3<f32>,
    transmittance: f32,
    // Opacity-weighted mean distance to the cloud along the ray, m.
    distance: f32,
}

fn march_clouds(
    origin_ws: vec3<f32>,
    dir: vec3<f32>,
    moon_lux: f32,
    sun_lux: f32,
    jitter: f32,
) -> CloudResult {
    var out: CloudResult;
    out.day = vec3<f32>(0.0);
    out.night = vec3<f32>(0.0);
    out.transmittance = 1.0;
    out.distance = 0.0;
    if sky.p1.x <= 0.001 || dir.y <= 0.004 {
        return out;
    }

    let sphere_origin = vec3<f32>(0.0, EARTH_R + sky.camera.w, 0.0);
    let t_in = sphere_exit(sphere_origin, dir, EARTH_R + sky.p2.z);
    let t_out = sphere_exit(sphere_origin, dir, EARTH_R + sky.p2.w);
    if t_in < 0.0 || t_out <= t_in {
        return out;
    }
    let near = max(t_in, 0.0);
    let far = min(t_out, MAX_CLOUD_DIST);
    if far <= near { return out; }

    // The march resolves the deck at a fixed metric step, not at a fixed
    // fraction of the (up to 140 km) shell path: a cloud's sunlit face is a
    // few hundred metres of density gradient, and the step has to land on
    // it or every cloud reads as its shadowed interior. Empty air is crossed
    // at three times the step; the budget in `p3.x` caps the sample count so
    // grazing rays through a long deck terminate. A per-pixel jitter of the
    // start point turns step banding into noise that TAA integrates away.
    let max_steps = i32(sky.p3.x);
    let light_steps = i32(sky.p3.y);
    let thickness = max(sky.p2.w - sky.p2.z, 200.0);
    let step_m = clamp(thickness / 14.0, 60.0, 250.0);
    let stride_m = step_m * 3.0;

    let moon_dir = sky.moon.xyz;
    let sun_dir = sky.sun.xyz;
    let cos_moon = dot(dir, moon_dir);
    let cos_sun = dot(dir, sun_dir);

    // Ambient. By day the deck's top is lit by the sky and its underside by
    // the sunlit ground; by night the underside is lit by the city and the
    // top by the moonlit sky. All four are radiances in cd/m2.
    let day_bottom = vec3<f32>(1.0, 0.985, 0.96) * sky.sun_tint.w;
    let day_top = sky.sky_ambient.rgb;
    let night_bottom = sky.skyglow.rgb * sky.skyglow.w * 0.5;
    let night_top = vec3<f32>(0.36, 0.42, 0.58) * (moon_lux * 0.35 + 0.0010);

    let sigma = 0.055;
    var dist_acc = 0.0;
    var t = near + jitter * step_m;
    var striding = false;
    for (var i = 0; i < max_steps; i = i + 1) {
        if out.transmittance < 0.006 || t >= far { break; }
        let p = sphere_origin + dir * t;
        let altitude = length(p) - EARTH_R;
        let world = origin_ws + dir * t;
        let sample = vec3<f32>(world.x, altitude, world.z);
        // Cheap probe first: cross empty air at the stride, and when a stride
        // lands inside cloud step back to the last empty point so the face
        // is resolved at the fine step rather than skipped.
        if cloud_density(sample, altitude, true) <= 0.0 {
            t = t + stride_m;
            striding = true;
            continue;
        }
        if striding {
            striding = false;
            t = t - stride_m + step_m;
            continue;
        }
        let d = cloud_density(sample, altitude, false);
        if d > 0.0005 {
            let h = height_fraction(altitude);
            let extinction = d * sigma;
            let powder = 1.0 - exp(-d * 6.0);
            var day = vec3<f32>(0.0);
            var night = vec3<f32>(0.0);
            if sun_lux > 1e-3 {
                let tau = light_transmittance(sample, altitude, sun_dir, light_steps) * sigma;
                day = day + sky.sun_tint.rgb * sun_lux * multi_scatter(tau, cos_sun)
                    * mix(1.0, powder, 0.55 * sat(0.5 - cos_sun * 0.5));
            }
            if moon_lux > 1e-5 {
                let tau = light_transmittance(sample, altitude, moon_dir, light_steps) * sigma;
                night = night + vec3<f32>(0.94, 0.96, 1.0) * moon_lux * multi_scatter(tau, cos_moon)
                    * mix(1.0, powder, 0.55 * sat(0.5 - cos_moon * 0.5));
            }
            // Ambient has to climb through whatever cloud is already between
            // this sample and its source, so it is attenuated by the depth
            // the ray has already accumulated. Without this the deck
            // converges to one flat grey wherever it is optically thick.
            let occlusion = 0.35 + 0.65 * out.transmittance;
            day = day + mix(day_bottom, day_top, h) * occlusion;
            night = night + mix(night_bottom, night_top, h) * occlusion;

            let step_t = exp(-extinction * step_m);
            let weight = (1.0 - step_t) * out.transmittance;
            let integ = (1.0 - step_t) / max(extinction, 1e-6);
            out.day = out.day + day * extinction * integ * out.transmittance;
            out.night = out.night + night * extinction * integ * out.transmittance;
            dist_acc = dist_acc + t * weight;
            out.transmittance = out.transmittance * step_t;
        }
        t = t + step_m;
    }
    let opacity = 1.0 - out.transmittance;
    if opacity > 1e-4 {
        out.distance = dist_acc / opacity;
    }
    return out;
}

// Interleaved-gradient noise (Jimenez 2014): a cheap, well-distributed
// per-pixel offset that TAA's jitter decorrelates frame to frame.
fn ign(pixel: vec2<f32>, frame: f32) -> f32 {
    let p = pixel + 5.588238 * (frame % 64.0);
    return fract(52.9829189 * fract(0.06711056 * p.x + 0.00583715 * p.y));
}

// ------------------------------------------------------------------- output

@fragment
fn main(in: FullscreenVertexOutput) -> @location(0) vec4<f32> {
    let ndc = vec4<f32>(in.uv.x * 2.0 - 1.0, 1.0 - in.uv.y * 2.0, 1.0, 1.0);
    let near_point = sky.world_from_clip * ndc;
    let dir = normalize(near_point.xyz / near_point.w - sky.camera.xyz);

    let debug = i32(sky.p3.z);
    let moon_lux = sky.p3.w;
    let sun_lux = sky.sun.w;
    let exposure_scene = sky.p0.x;
    let exposure_sky = sky.p4.x;

    // Stars fade out below the geometric horizon: the plate covers the whole
    // sphere, and the ground does not.
    let horizon = sat((dir.y + 0.004) / 0.02);
    let celestial = (star_radiance(dir) + moon_radiance(dir)) * horizon;

    let jitter = ign(in.position.xy, floor(sky.p1.z * 60.0));
    let cloud = march_clouds(sky.camera.xyz, dir, moon_lux, sun_lux, jitter);
    let opacity = 1.0 - cloud.transmittance;

    // Aerial perspective: the air between observer and deck extinguishes the
    // cloud's radiance and replaces it with in-scatter. Of the atmosphere's
    // in-scatter already in the target, that same fraction is left in front
    // of the deck. The optical depth is integrated up the slant path for
    // two exponential terms (Rayleigh; aerosol/fog) in closed form:
    // tau = beta0 * H * (1 - exp(-z / H)) / sin(elevation).
    let slant = max(dir.y, 0.015);
    let z = cloud.distance * slant;
    let tau_r = sky.p4.y * sky.p4.z * (1.0 - exp(-z / sky.p4.z)) / slant;
    let tau_a = sky.p4.w * sky.sky_ambient.w * (1.0 - exp(-z / sky.sky_ambient.w)) / slant;
    let ap = 1.0 - exp(-(tau_r + tau_a));
    let keep = cloud.transmittance + ap * opacity;

    // Urban skyglow sits between the observer and the deck, so it is added
    // after the cloud attenuation and brightens toward the horizon, where
    // the low-pressure-sodium/warm-LED chromaticity of street lighting takes
    // over from the blue-grey of the zenith.
    let low = pow(1.0 - sat(dir.y), 3.0);
    let glow_rgb = mix(sky.skyglow.rgb, vec3<f32>(1.0, 0.72, 0.42), sat(low * 1.4));
    let glow = glow_rgb * sky.skyglow.w * (0.22 + 1.9 * low) * horizon;

    let in_front = 1.0 - ap;
    var colour = (celestial * cloud.transmittance + glow) * exposure_scene
        + cloud.night * in_front * exposure_scene * sky.p5.x
        + cloud.day * in_front * exposure_sky;

    if debug == 1 {
        return vec4<f32>(vec3<f32>(opacity), 1.0);
    } else if debug == 2 {
        return vec4<f32>(star_radiance(dir) * horizon * exposure_scene, 1.0);
    } else if debug == 3 {
        return vec4<f32>(moon_radiance(dir) * exposure_scene, 1.0);
    } else if debug == 4 {
        // Cloud radiance alone, no aerial perspective, opaque: what the
        // deck would look like in a vacuum.
        return vec4<f32>(cloud.day * exposure_sky + cloud.night * exposure_scene * sky.p5.x, 1.0);
    }

    return vec4<f32>(colour, 1.0 - keep);
}
