/** Read one canonical SIMFORGE_* environment variable. */
export function simforgeEnv(name) {
  return process.env[`SIMFORGE_${name}`];
}
