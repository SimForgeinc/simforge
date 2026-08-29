import { describe, expect, it } from "vitest";

import {
  authoredClipCompleted,
  authoredPlaybackRequiresReset,
} from "../../lib/live-world/authored-world-session";
import { actorSpeedKph, formatClipTime, speedMpsToKph } from "./drive-telemetry";

describe("Drive clip completion and telemetry", () => {
  it("transitions to completed exactly at the authored boundary without treating nearby earlier frames as complete", () => {
    expect(authoredClipCompleted(19.999, 20)).toBe(false);
    expect(authoredClipCompleted(20, 20)).toBe(true);
    expect(authoredClipCompleted(20.02, 20)).toBe(true);
    expect(authoredClipCompleted(Number.NaN, 20)).toBe(false);
  });
  it("replays by resetting a completed clip while resuming a paused mid-clip world in place", () => {
    expect(authoredPlaybackRequiresReset(false, 8, 20)).toBe(false);
    expect(authoredPlaybackRequiresReset(true, 20, 20)).toBe(true);
    expect(authoredPlaybackRequiresReset(false, 20, 20)).toBe(true);
  });

  it("converts truth-frame velocity from m/s to km/h exactly once", () => {
    expect(speedMpsToKph(10)).toBe(36);
    expect(actorSpeedKph({
      scene: { actors: [{ id: "ego", velocity: [13.4112, 0, 0] }] },
    }, "ego")).toBeCloseTo(48.28032, 8);
    expect(actorSpeedKph({
      scene: { actors: [{ id: "other", velocity: [40, 0, 0] }] },
    }, "ego")).toBe(0);
  });

  it("formats and clamps authored clip time at the visible duration", () => {
    expect(formatClipTime(12.36, 20)).toBe("12.4 / 20.0 s");
    expect(formatClipTime(20.02, 20)).toBe("20.0 / 20.0 s");
    expect(formatClipTime(-1, 20)).toBe("0.0 / 20.0 s");
  });
});
