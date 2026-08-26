"""Drop-in ``carla`` shim.

Installs alongside :mod:`simforge_oss_carla_api` so CARLA-ecosystem tools can
``import carla`` and run against SimForge unmodified. This is NOT the
real carla package: everything is served by the SimForge engine through
the facade (see adapters/carla-api/README.md for the coverage matrix).
"""

from simforge_oss_carla_api import *  # noqa: F401,F403
from simforge_oss_carla_api import __version__  # noqa: F401
