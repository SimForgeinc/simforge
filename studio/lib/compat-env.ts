export function simforgeEnv(name: string): string | undefined {
  return process.env[`SIMFORGE_${name}`];
}
