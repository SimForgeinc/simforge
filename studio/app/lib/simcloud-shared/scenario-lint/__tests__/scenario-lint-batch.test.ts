import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const CLI = fileURLToPath(
  new URL("../../bin/scenario-lint-batch.ts", import.meta.url),
);
const TSX = fileURLToPath(
  new URL("../../../../../node_modules/.bin/tsx", import.meta.url),
);

let root: string | null = null;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = null;
});

function actorTrack(teleport: boolean, declared = false) {
  const frames = Array.from({ length: 41 }, (_, index) => {
    const timestamp = index * 0.05;
    return {
      frame: index,
      timestamp,
      actors: [
        {
          actor_spec_id: teleport ? "bad-ego" : "clean-ego",
          kind: "vehicle",
          role: "ego",
          x: 5 * timestamp + (teleport && timestamp >= 1 ? 20 : 0),
          y: 0,
          yaw: 0,
          speed_mps: 5,
          ...(declared
            ? { behaviorMetadata: { behavior_class: "adversarial" } }
            : {}),
        },
      ],
    };
  });
  return {
    version: 1,
    frame_count: frames.length,
    fixed_delta_seconds: 0.05,
    frames,
  };
}

async function makeFixture(): Promise<string> {
  root = await mkdtemp(join(tmpdir(), "scenario-lint-batch-"));
  const clean = join(root, "clean");
  const badRun = join(root, "bad", "run");
  await mkdir(clean, { recursive: true });
  await mkdir(badRun, { recursive: true });
  await writeFile(join(clean, "summary.json"), "{}\n");
  await writeFile(
    join(clean, "actor_track.json"),
    JSON.stringify(actorTrack(false)),
  );
  await writeFile(join(root, "bad", "summary.json"), "{}\n");
  await writeFile(
    join(badRun, "actor_track.json"),
    JSON.stringify(actorTrack(true)),
  );
  return root;
}

function runCli(renderRoot: string, strict = false) {
  return spawnSync(TSX, [CLI, renderRoot, ...(strict ? ["--strict"] : [])], {
    encoding: "utf8",
  });
}

describe("scenario-lint-batch CLI", () => {
  it("writes per-run and aggregate reports for clean and violating runs", async () => {
    const renderRoot = await makeFixture();

    const result = runCli(renderRoot);

    expect(result.status, result.stderr).toBe(0);
    const clean = JSON.parse(
      await readFile(join(renderRoot, "clean", "lint.json"), "utf8"),
    );
    const bad = JSON.parse(
      await readFile(join(renderRoot, "bad", "lint.json"), "utf8"),
    );
    const aggregate = JSON.parse(
      await readFile(join(renderRoot, "LINT_REPORT.json"), "utf8"),
    );
    const markdown = await readFile(
      join(renderRoot, "LINT_REPORT.md"),
      "utf8",
    );

    expect(clean.verdict).toBe("pass");
    expect(clean.unexplained_violation_count).toBe(0);
    expect(bad.verdict).toBe("fail");
    expect(bad.unexplained_violation_count).toBeGreaterThan(0);
    expect(aggregate.totals).toMatchObject({
      run_count: 2,
      pass_count: 1,
      failing_scene_count: 1,
    });
    expect(
      aggregate.violation_rate_by_kind.position_discontinuity.scene_rate,
    ).toBe(0.5);
    expect(aggregate.top_offending_scenes[0]).toMatchObject({
      scene: "bad",
      actor_id: "bad-ego",
    });
    expect(aggregate.top_offending_scenes[0].peak_value).toBeGreaterThan(20);
    expect(markdown).toContain("# Scenario lint batch report");
    expect(markdown).toContain("| bad | bad-ego |");
  });

  it("exits non-zero in strict mode when a violation is unexplained", async () => {
    const renderRoot = await makeFixture();

    const result = runCli(renderRoot, true);

    expect(result.status).toBe(2);
  });

  it("accepts strict mode when every violation is declared adversarial", async () => {
    const renderRoot = await makeFixture();
    await writeFile(
      join(renderRoot, "bad", "run", "actor_track.json"),
      JSON.stringify(actorTrack(true, true)),
    );

    const result = runCli(renderRoot, true);
    const bad = JSON.parse(
      await readFile(join(renderRoot, "bad", "lint.json"), "utf8"),
    );

    expect(result.status, result.stderr).toBe(0);
    expect(bad.unexplained_violation_count).toBe(0);
    expect(bad.declared_violation_count).toBeGreaterThan(0);
    expect(
      bad.findings.some(
        (finding: { annotation?: string }) =>
          finding.annotation === "declared-violating",
      ),
    ).toBe(true);
  });
});
