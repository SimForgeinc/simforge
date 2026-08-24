"""Thin rosbag2 helpers: sim-time-stamped sqlite3 bags, version-tolerant.

All messages are written with the *simulation* timestamp (ns), so bags are
byte-stable across runs regardless of wall-clock scheduling.
"""

from __future__ import annotations

from pathlib import Path
from typing import Iterator

import rosbag2_py
from rclpy.serialization import deserialize_message, serialize_message
from rosidl_runtime_py.utilities import get_message


def _topic_metadata(name: str, type_name: str) -> rosbag2_py.TopicMetadata:
    try:  # Jazzy signature carries a leading numeric id.
        return rosbag2_py.TopicMetadata(id=0, name=name, type=type_name, serialization_format="cdr")
    except TypeError:  # Humble-era signature.
        return rosbag2_py.TopicMetadata(name=name, type=type_name, serialization_format="cdr")


class BagWriter:
    def __init__(self, uri: str | Path) -> None:
        self._writer = rosbag2_py.SequentialWriter()
        self._writer.open(
            rosbag2_py.StorageOptions(uri=str(uri), storage_id="sqlite3"),
            rosbag2_py.ConverterOptions(input_serialization_format="cdr", output_serialization_format="cdr"),
        )
        self._topics: set[str] = set()

    def create_topic(self, name: str, type_name: str) -> None:
        if name in self._topics:
            return
        self._writer.create_topic(_topic_metadata(name, type_name))
        self._topics.add(name)

    def write(self, topic: str, message, sim_time_ns: int) -> None:
        self._writer.write(topic, serialize_message(message), sim_time_ns)

    def close(self) -> None:
        # rosbag2_py finalizes on destruction; drop the reference eagerly.
        del self._writer


def read_bag(uri: str | Path, topics: list[str] | None = None) -> Iterator[tuple[str, object, int]]:
    """Yield (topic, deserialized message, sim_time_ns) in recorded order."""
    reader = rosbag2_py.SequentialReader()
    reader.open(
        rosbag2_py.StorageOptions(uri=str(uri), storage_id="sqlite3"),
        rosbag2_py.ConverterOptions(input_serialization_format="cdr", output_serialization_format="cdr"),
    )
    types = {t.name: get_message(t.type) for t in reader.get_all_topics_and_types()}
    if topics:
        reader.set_filter(rosbag2_py.StorageFilter(topics=topics))
    while reader.has_next():
        topic, raw, t_ns = reader.read_next()
        yield topic, deserialize_message(raw, types[topic]), t_ns
