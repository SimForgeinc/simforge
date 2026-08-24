"""Unit tests for the deployment perturbation wrappers (stdlib only + numpy)."""

from __future__ import annotations

import sys
import pathlib
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import numpy as np  # noqa: E402

from policy_eval_runner.perturb import (  # noqa: E402
    EgoStateNoisePolicy,
    LatencyPolicy,
    episode_noise_seed,
)


class CountingPolicy:
    name = "counting"
    calls = 0
    actions = [1, 2, 3, 4, 5]

    def act(self, frame):
        action = {"n": self.actions[min(self.calls, len(self.actions) - 1)]}
        self.calls += 1
        return action


def frame(sv=(0.0,) * 10):
    return {"state_vector": np.array(sv), "bev": None}


class TestLatency(unittest.TestCase):
    def test_delays_actions_by_k_decisions(self):
        inner = CountingPolicy()
        latency = LatencyPolicy(inner, 2)
        out = [latency.act(frame()) for _ in range(5)]
        # Two warm-up no-ops, then the delayed stream.
        self.assertEqual([a["n"] if a else None for a in out], [None, None, 1, 2, 3])

    def test_zero_ticks_is_passthrough(self):
        latency = LatencyPolicy(CountingPolicy(), 0)
        out = [latency.act(frame())["n"] for _ in range(3)]
        self.assertEqual(out, [1, 2, 3])

    def test_reset_clears_pipeline_and_propagates(self):
        inner = CountingPolicy()
        latency = LatencyPolicy(inner, 3)
        latency.act(frame())
        seen = []
        inner.reset_episode = lambda entry_id: seen.append(entry_id) or setattr(inner, "calls", 0)
        latency.reset_episode("e|base")
        self.assertEqual(seen, ["e|base"])
        self.assertEqual(latency._pipeline, [])


    def test_deterministic_for_same_seed(self):
        captured_a, captured_b = {}, {}

        class CaptureA(CountingPolicy):
            def act(self, f):
                captured_a["sv"] = f["state_vector"].copy()
                return super().act(f)

        class CaptureB(CountingPolicy):
            def act(self, f):
                captured_b["sv"] = f["state_vector"].copy()
                return super().act(f)

        a = EgoStateNoisePolicy(CaptureA(), 0.5, seed=1234)
        b = EgoStateNoisePolicy(CaptureB(), 0.5, seed=1234)
        base = np.array([1.0] * 10)
        a.act({"state_vector": base.copy(), "bev": None})
        b.act({"state_vector": base.copy(), "bev": None})
        self.assertTrue(np.allclose(captured_a["sv"], captured_b["sv"]))
        self.assertFalse(np.allclose(captured_a["sv"], base))

    def test_inner_receives_noisy_copy_original_untouched(self):
        captured = {}

        class Capture(CountingPolicy):
            def act(self, f):
                captured["sv"] = f["state_vector"]
                return super().act(f)

        original = np.array([1.0] * 10)
        noise = EgoStateNoisePolicy(Capture(), std=1.0, seed=7)
        noise.act({"state_vector": original, "bev": None})
        self.assertIsNot(captured["sv"], original)
        self.assertFalse(np.allclose(captured["sv"], original))
        self.assertTrue(np.allclose(original, [1.0] * 10))

    def test_seed_depends_on_replay_key(self):
        s1 = episode_noise_seed("hash", "arm", "entry", "ns0.5")
        s2 = episode_noise_seed("hash", "arm", "entry", "ns0.5")
        s3 = episode_noise_seed("hash", "arm", "other-entry", "ns0.5")
        self.assertEqual(s1, s2)
        self.assertNotEqual(s1, s3)


if __name__ == "__main__":
    unittest.main()
