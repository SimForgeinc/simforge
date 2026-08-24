#include <algorithm>
#include <cstdint>
#include <cstring>
#include <exception>
#include <filesystem>
#include <fstream>
#include <string>
#include <unordered_set>
#include <vector>

#include <libsumo/Simulation.h>
#include <libsumo/TrafficLight.h>
#include <libsumo/Vehicle.h>

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#define US_EXPORT extern "C" EMSCRIPTEN_KEEPALIVE
#else
#define US_EXPORT extern "C"
#endif

namespace {

// Exactly eight 32-bit words. JavaScript views word 0/7 as uint32 and the
// middle fields as float32 without serializing one object per vehicle.
struct alignas(4) PackedState {
    std::uint32_t idHash;
    float x;
    float y;
    float headingDegrees;
    float speedMetersPerSecond;
    float accelerationMetersPerSecondSquared;
    float lanePositionMeters;
    std::uint32_t signals;
};
static_assert(sizeof(PackedState) == 32, "PackedState ABI changed");

// One record per controlled link. Controller ids are stable FNV-1a hashes;
// the Studio resolves them against physical OpenDRIVE head provenance parsed
// once from the same network document.
struct alignas(4) PackedSignalState {
    std::uint32_t controllerHash;
    std::uint16_t linkIndex;
    std::uint8_t state;
    std::uint8_t reserved;
};
static_assert(sizeof(PackedSignalState) == 8, "PackedSignalState ABI changed");

std::vector<PackedState> states;
std::vector<PackedSignalState> signalStates;
std::unordered_set<std::string> externalIds;
std::string lastError;
double simulationTime = 0;
bool loaded = false;

std::uint32_t fnv1a(const std::string& value) {
    std::uint32_t hash = 2166136261u;
    for (const unsigned char byte : value) {
        hash ^= byte;
        hash *= 16777619u;
    }
    return hash;
}

void writeBytes(const std::filesystem::path& path, const void* data, const int length) {
    std::ofstream output(path, std::ios::binary | std::ios::trunc);
    if (!output) throw std::runtime_error("Cannot create " + path.string());
    output.write(static_cast<const char*>(data), length);
    if (!output) throw std::runtime_error("Cannot write " + path.string());
}

template <class Fn>
int guarded(Fn&& callback) {
    try {
        lastError.clear();
        callback();
        return 0;
    } catch (const std::exception& error) {
        lastError = error.what();
    } catch (...) {
        lastError = "Unknown SUMO failure";
    }
    return 1;
}

bool isVehicle(const std::string& id) {
    const auto ids = libsumo::Vehicle::getIDList();
    return std::find(ids.begin(), ids.end(), id) != ids.end();
}

void refreshStates() {
    states.clear();
    for (const auto& id : libsumo::Vehicle::getIDList()) {
        if (externalIds.find(id) != externalIds.end()) continue;
        const auto position = libsumo::Vehicle::getPosition3D(id);
        states.push_back(PackedState{
            fnv1a(id),
            static_cast<float>(position.x),
            static_cast<float>(position.y),
            static_cast<float>(libsumo::Vehicle::getAngle(id)),
            static_cast<float>(libsumo::Vehicle::getSpeed(id)),
            static_cast<float>(libsumo::Vehicle::getAcceleration(id)),
            static_cast<float>(libsumo::Vehicle::getLanePosition(id)),
            static_cast<std::uint32_t>(libsumo::Vehicle::getSignals(id)),
        });
    }
}

void refreshSignalStates() {
    signalStates.clear();
    for (const auto& controllerId : libsumo::TrafficLight::getIDList()) {
        const auto state = libsumo::TrafficLight::getRedYellowGreenState(controllerId);
        for (std::size_t index = 0; index < state.size(); ++index) {
            signalStates.push_back(PackedSignalState{
                fnv1a(controllerId),
                static_cast<std::uint16_t>(index),
                static_cast<std::uint8_t>(state[index]),
                0,
            });
        }
    }
}

} // namespace

US_EXPORT int us_sumo_start(
    const void* networkXml,
    const int networkLength,
    const void* routesXml,
    const int routesLength,
    const double stepSeconds,
    const int seed) {
    return guarded([&] {
        if (loaded) libsumo::Simulation::close("Restarting browser SUMO");
        std::filesystem::create_directories("/input");
        writeBytes("/input/network.net.xml", networkXml, networkLength);
        writeBytes("/input/routes.rou.xml", routesXml, routesLength);
        const std::vector<std::string> args{
            "sumo-wasm",
            "--net-file", "/input/network.net.xml",
            "--route-files", "/input/routes.rou.xml",
            "--step-length", std::to_string(stepSeconds),
            "--seed", std::to_string(seed),
            "--no-step-log", "true",
            "--duration-log.disable", "true",
            "--ignore-route-errors", "true",
        };
        libsumo::Simulation::start(args);
        simulationTime = 0;
        states.clear();
        signalStates.clear();
        externalIds.clear();
        loaded = true;
        // Materialize depart="0" actors so the first browser frame has state.
        libsumo::Simulation::step(0);
        refreshStates();
        refreshSignalStates();
    });
}

US_EXPORT int us_sumo_step(const double deltaSeconds) {
    return guarded([&] {
        if (!loaded) throw std::runtime_error("SUMO is not initialized");
        if (!(deltaSeconds > 0) || deltaSeconds > 5) throw std::runtime_error("Invalid step interval");
        simulationTime += deltaSeconds;
        libsumo::Simulation::step(simulationTime);
        refreshStates();
        refreshSignalStates();
    });
}

US_EXPORT int us_sumo_upsert_external(
    const char* rawId,
    const int kind,
    const char* rawRouteId,
    const double x,
    const double y,
    const double headingDegrees,
    const double speedMetersPerSecond,
    const double lengthMeters,
    const double widthMeters) {
    return guarded([&] {
        if (!loaded) throw std::runtime_error("SUMO is not initialized");
        const std::string id(rawId == nullptr ? "" : rawId);
        const std::string routeId(rawRouteId == nullptr ? "" : rawRouteId);
        if (id.empty()) throw std::runtime_error("External actor id is empty");
        externalIds.insert(id);
        // Pedestrians, bicycles and physical obstacles deliberately use
        // hidden vehicle-shaped occupancy proxies. This is conservative but
        // guarantees car-following perception even when an imported
        // OpenDRIVE map lacks explicit SUMO walking-area/crossing topology.
        if (!isVehicle(id)) {
            libsumo::Vehicle::add(id, routeId, kind == 2 ? "DEFAULT_BIKETYPE" : "DEFAULT_VEHTYPE");
            libsumo::Vehicle::setSpeedMode(id, 0);
            libsumo::Vehicle::setLaneChangeMode(id, 0);
            libsumo::Vehicle::setLength(id, lengthMeters);
            libsumo::Vehicle::setWidth(id, widthMeters);
        }
        libsumo::Vehicle::moveToXY(id, "", -1, x, y, headingDegrees, 2, 250);
        libsumo::Vehicle::setSpeed(id, kind == 3 ? 0 : speedMetersPerSecond);
    });
}

US_EXPORT int us_sumo_remove(const char* rawId) {
    return guarded([&] {
        const std::string id(rawId == nullptr ? "" : rawId);
        if (isVehicle(id)) libsumo::Vehicle::remove(id);
        externalIds.erase(id);
    });
}

US_EXPORT const void* us_sumo_state_pointer() { return states.data(); }
US_EXPORT int us_sumo_state_count() { return static_cast<int>(states.size()); }
US_EXPORT const void* us_sumo_signal_state_pointer() { return signalStates.data(); }
US_EXPORT int us_sumo_signal_state_count() { return static_cast<int>(signalStates.size()); }
US_EXPORT double us_sumo_time() { return simulationTime; }
US_EXPORT const char* us_sumo_last_error() { return lastError.c_str(); }

US_EXPORT void us_sumo_close() {
    if (loaded) {
        try { libsumo::Simulation::close("Browser provider closed"); } catch (...) {}
    }
    loaded = false;
    simulationTime = 0;
    states.clear();
    signalStates.clear();
    externalIds.clear();
}
