import { describe, expect, it, vi } from "vitest";
import { Box3, Vector3 } from "three";
import { indexedWorldHeightSampler } from './indexed-height-sampler';

describe("indexedWorldHeightSampler", () => {
  it("uses direct, nearby, then map-datum indexed heights without per-frame raycasts", () => {
    const sample = vi.fn((x: number) => x === 10 ? 2.5 : null);
    const sampleNear = vi.fn((x: number, _z: number, radius?: number) => {
      if (radius === 400) return 1.25;
      return x === 20 ? 3.5 : null;
    });
    const getGroundIndex = vi.fn(() => ({
      bounds: () => new Box3(new Vector3(0, 0, 0), new Vector3(100, 0, 100)),
      sample,
      sampleNear,
    }));
    const sampleGroundHeight = vi.fn(() => 99);
    const height = indexedWorldHeightSampler({ getGroundIndex, sampleGroundHeight });

    expect(height(10, 5)).toBe(2.5);
    expect(height(20, 5)).toBe(3.5);
    expect(height(500, 500)).toBe(1.25);

    expect(getGroundIndex).toHaveBeenCalledOnce();
    expect(sampleGroundHeight).not.toHaveBeenCalled();
    expect(sampleNear).toHaveBeenCalledWith(20, 5, 8);
  });

  it("uses one live query for the datum when the index center has no surface", () => {
    const sampleGroundHeight = vi.fn(() => 7);
    const height = indexedWorldHeightSampler({
      getGroundIndex: () => ({
        bounds: () => new Box3(new Vector3(-10, 0, -10), new Vector3(10, 0, 10)),
        sample: () => null,
        sampleNear: () => null,
      }),
      sampleGroundHeight,
    });

    expect(height(100, 100)).toBe(7);
    expect(height(200, 200)).toBe(7);
    expect(sampleGroundHeight).toHaveBeenCalledOnce();
    expect(sampleGroundHeight).toHaveBeenCalledWith(0, 0);
  });

  it("temporarily falls back to the live sampler until road geometry is indexed", () => {
    const index = {
      bounds: () => new Box3(new Vector3(0, 0, 0), new Vector3(20, 0, 20)),
      sample: () => 4,
      sampleNear: () => 4,
    };
    const getGroundIndex = vi
      .fn()
      .mockReturnValueOnce(null)
      .mockReturnValue(index);
    const sampleGroundHeight = vi.fn(() => 3);
    const height = indexedWorldHeightSampler({ getGroundIndex, sampleGroundHeight });

    expect(height(1, 1)).toBe(3);
    expect(height(2, 2)).toBe(4);
    expect(height(3, 3)).toBe(4);
    expect(getGroundIndex).toHaveBeenCalledTimes(2);
    expect(sampleGroundHeight).toHaveBeenCalledOnce();
  });
});
