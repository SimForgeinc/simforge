"""Drop-in ``carla`` shim.

Installs alongside :mod:`uniscenarios_carla` so CARLA-ecosystem tools can
``import carla`` and run against UniScenarios unmodified. This is NOT the
real carla package: everything is served by the UniScenarios engine through
the facade (see adapters/carla-compat/README.md for the coverage matrix).
"""

from uniscenarios_carla import *  # noqa: F401,F403
from uniscenarios_carla import __version__  # noqa: F401
