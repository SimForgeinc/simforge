"""SimForge ROS 2 bridge — lockstepped clock/TF/odometry out, Ackermann control in.

Speaks the simforge-env-server wire protocol (length-prefixed MessagePack,
see packages/training-env/src/env-server.ts) as the simulation client and
mirrors the sim into a ROS 2 graph under deterministic sim time.
"""

__all__ = ["env_client", "trace", "bag_io"]
