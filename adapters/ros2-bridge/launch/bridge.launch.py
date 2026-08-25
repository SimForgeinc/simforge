"""Launch the SimForge bridge without an installed ament package.

Runs the bridge module directly from the source tree (PYTHONPATH points at
adapters/ros2-bridge), so a sourced ROS 2 environment is the only setup:

    ros2 launch adapters/ros2-bridge/launch/bridge.launch.py \
        episodes:=adapters/ros2-bridge/config/episodes/synthetic-straight.episodes.json \
        seed:=my-seed bag_dir:=/tmp/sf-bridge-bag
"""

from __future__ import annotations

import os
from pathlib import Path

from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, ExecuteProcess
from launch.substitutions import LaunchConfiguration

_ADAPTER_DIR = Path(__file__).resolve().parents[1]


def generate_launch_description() -> LaunchDescription:
    episodes = LaunchConfiguration("episodes")
    seed = LaunchConfiguration("seed")
    bag_dir = LaunchConfiguration("bag_dir")
    meta_path = LaunchConfiguration("meta_path")
    control_mode = LaunchConfiguration("control_mode")
    max_ticks = LaunchConfiguration("max_ticks")

    env = dict(os.environ)
    env["PYTHONPATH"] = f"{_ADAPTER_DIR}:{env.get('PYTHONPATH', '')}"

    return LaunchDescription(
        [
            DeclareLaunchArgument("episodes"),
            DeclareLaunchArgument("seed", default_value="ros2-bridge"),
            DeclareLaunchArgument("bag_dir", default_value=""),
            DeclareLaunchArgument("meta_path", default_value=""),
            DeclareLaunchArgument("control_mode", default_value="passthrough"),
            DeclareLaunchArgument("max_ticks", default_value="0"),
            ExecuteProcess(
                cmd=[
                    "python3",
                    "-m",
                    "simforge_ros2_bridge.bridge_node",
                    "--ros-args",
                    "--params-file",
                    str(_ADAPTER_DIR / "config" / "bridge.params.yaml"),
                    "-p", ["episodes:=", episodes],
                    "-p", ["seed:=", seed],
                    "-p", ["bag_dir:=", bag_dir],
                    "-p", ["meta_path:=", meta_path],
                    "-p", ["control_mode:=", control_mode],
                    "-p", ["max_ticks:=", max_ticks],
                ],
                env=env,
                output="screen",
            ),
        ]
    )
