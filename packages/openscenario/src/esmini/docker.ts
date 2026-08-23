import type { EsminiRunnerLimits } from './contracts.js';

export interface DockerMounts { readonly inputDir: string; readonly outputDir: string; }

/** Auditable production isolation profile. Input is read-only; only /out is writable. */
export function buildDockerInvocation(mounts: DockerMounts, limits: EsminiRunnerLimits, scenarioPath: string, image: string): readonly string[] {
  if (!/@sha256:[0-9a-f]{64}$/u.test(image)) throw new Error('production esmini image must be pinned by immutable sha256 digest');
  return [
    'run', '--rm', '--network=none', '--read-only', '--cap-drop=ALL',
    '--security-opt=no-new-privileges', '--pids-limit=64',
    `--cpus=${limits.cpuCount}`, `--memory=${limits.memoryMiB}m`,
    '--user=65532:65532', '--tmpfs=/tmp:rw,noexec,nosuid,size=64m',
    '--mount', `type=bind,src=${mounts.inputDir},dst=/input,readonly`,
    '--mount', `type=bind,src=${mounts.outputDir},dst=/out`,
    image,
    '--osc', `/input/${scenarioPath}`, '--headless', '--fixed_timestep', '0.02',
    '--traj_filter', '0',
    '--collision', '--record', '/out/replay.dat', '--csv_logger', '/out/replay.csv',
    '--osi_file', '/out/replay.osi', '--logfile_path', '/out/esmini.log',
  ];
}
