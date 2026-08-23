"""uniscenarios_carla — a CARLA-compatible Python API facade.

Maps the subset of the ``carla`` client API that CARLA-ecosystem tools
actually use (see README coverage matrix) onto the UniScenarios env-server
and its render path. Import this package directly, or use the drop-in
``carla`` shim package installed alongside it.
"""

from .client import Client, ScenarioInfo
from ._envclient import ProtocolError, ServerError
from .actors import Actor, Sensor, SensorFrame, TrafficLight, Vehicle, VehicleControl, Walker, WalkerControl
from .blueprint import ActorBlueprint, BlueprintLibrary
from .debug import Color, DebugHelper
from .frames import BrowserClipFrameSource, FrameSource, NullFrameSource
from .geoloc import GeoLocation
from .geom import Location, Rotation, Transform, Vector3D
from .lane_types import LaneType
from .map import Map, Waypoint
from .physics import VehiclePhysicsControl, WheelPhysicsControl
from .trafficmanager import TrafficManager
from .weather import WeatherParameters
from .world import World, WorldSettings, WorldSnapshot

__version__ = "0.1.0"

__all__ = [
    "Actor", "ActorBlueprint", "BlueprintLibrary", "BrowserClipFrameSource",
    "Client", "Color", "DebugHelper", "FrameSource", "GeoLocation",
    "LaneType", "Location", "Map", "NullFrameSource", "ProtocolError",
    "Rotation", "ScenarioInfo", "Sensor", "SensorFrame", "ServerError",
    "TrafficLight", "TrafficManager", "Transform", "Vector3D", "Vehicle",
    "VehicleControl", "VehiclePhysicsControl", "Walker", "WalkerControl",
    "Waypoint", "WeatherParameters", "WheelPhysicsControl", "World",
    "WorldSettings", "WorldSnapshot", "__version__",
]
