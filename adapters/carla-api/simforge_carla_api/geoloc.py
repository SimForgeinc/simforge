"""Geolocation transforms matching V2XCarla ``geo_utils.py``'s flat-earth
contract (its CARLA 0.10 code path).

Legacy contract (geo_utils.py, 0.10 branch):

- The map origin carries WGS-84 ``lat_0``/``lon_0`` from the OpenDRIVE
  ``<geoReference>`` tmerc projection.
- ``gps_to_carla``: ``x = (lon - lon0) * 111320 * cos(lat0)``,
  ``y = -((lat - lat0) * 111320)`` — the UE4 left-handed Y flip — then Z
  snaps to the road surface.
- On CARLA 0.10 ``transform_to_geolocation`` returns **correct WGS-84**:
  latitude grows with northing, longitude with easting.

The facade presents the xodr-local frame directly (x = easting,
y = northing; see geom.py), so the UE4 Y-flip is already absent from this
frame and both directions reduce to a flat-earth approximation that
round-trips to the same WGS-84 the legacy bridge computes:

    lat = lat0 + y / 111320
    lon = lon0 + x / (111320 * cos(lat0))

Accuracy is centimetres at site scale (same approximation order as the
legacy implementation). Golden fixtures from the map-parity workstream will
pin exact site points; until then tests verify round-trip and formula
equality against geo_utils' expressions.

Pending-fixtures status: implemented from geo_utils formulas; awaiting
v2x-map-parity golden projection fixtures as additional test vectors.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from pathlib import Path

#: Legacy flat-earth constant (geo_utils.py meters_per_deg_lat).
METERS_PER_DEG_LAT = 111_320.0

_GEO_REF_RE = re.compile(r"<geoReference>\s*<!\[CDATA\[(.*?)\]\]>", re.S)
_LAT0_RE = re.compile(r"\blat_0=([-\d.eE+]+)")
_LON0_RE = re.compile(r"\blon_0=([-\d.eE+]+)")


@dataclass(frozen=True)
class GeoLocation:
    """WGS-84 position in decimal degrees (mirrors carla.GeoLocation)."""

    latitude: float
    longitude: float
    altitude: float = 0.0

    def __repr__(self) -> str:  # pragma: no cover - cosmetic
        return f"GeoLocation(lat={self.latitude:.7f}, lon={self.longitude:.7f})"


@dataclass(frozen=True)
class GeoOrigin:
    """The map's georeference origin plus derived flat-earth scales."""

    lat0: float
    lon0: float

    @property
    def meters_per_deg_lon(self) -> float:
        return METERS_PER_DEG_LAT * math.cos(math.radians(self.lat0))


def parse_geo_origin(xodr_path: str | Path) -> GeoOrigin | None:
    """Extract ``lat_0``/``lon_0`` from an OpenDRIVE ``<geoReference>``."""
    raw = Path(xodr_path).read_text(encoding="utf-8", errors="replace")
    return parse_geo_origin_text(raw[:400_000])


def parse_geo_origin_text(header_text: str) -> GeoOrigin | None:
    match = _GEO_REF_RE.search(header_text)
    proj = match.group(1) if match else header_text
    lat = _LAT0_RE.search(proj)
    lon = _LON0_RE.search(proj)
    if lat is None or lon is None:
        return None
    return GeoOrigin(lat0=float(lat.group(1)), lon0=float(lon.group(1)))


def transform_to_geolocation(origin: GeoOrigin, x: float, y: float,
                             z: float = 0.0) -> GeoLocation:
    """Facade world (x=easting, y=northing) → correct WGS-84 (0.10 contract)."""
    return GeoLocation(
        latitude=origin.lat0 + y / METERS_PER_DEG_LAT,
        longitude=origin.lon0 + x / origin.meters_per_deg_lon,
        altitude=z,
    )


def geolocation_to_transform(origin: GeoOrigin, latitude: float,
                             longitude: float) -> tuple[float, float]:
    """Flat-earth inverse of :func:`transform_to_geolocation`.

    Matches geo_utils.gps_to_carla's 0.10 expressions with the frame's
    northing sign restored (the legacy UE4 ``y = -(northing)`` flip does not
    exist in the facade frame).
    """
    return (
        (longitude - origin.lon0) * origin.meters_per_deg_lon,
        (latitude - origin.lat0) * METERS_PER_DEG_LAT,
    )
