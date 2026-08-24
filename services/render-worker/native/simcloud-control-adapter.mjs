import { appendFileSync } from "node:fs";
const CONTROL_SCHEMA = "uniscenario.render-worker-control/v2";
const ERROR_LOG = `${process.env.UNISCENARIOS_SCRATCH_DIR ?? "/scratch"}/control-errors.log`;

export function createRenderControlTransport(options) {
  const baseUrl = new URL(String(options.baseUrl));
  const workerId = String(options.workerId);
  const tokenEnv = String(options.tokenEnv ?? "UNISCENARIO_RENDER_WORKER_TOKEN");
  const token = process.env[tokenEnv];
  if (!token) throw new Error(`control token environment variable ${tokenEnv} is not set`);
  const jobsByLease = new Map();
  async function post(path, body, signal) {
    const response = await fetch(new URL(path, baseUrl), { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-uniscenario-worker-node-id": workerId }, body: JSON.stringify(body), signal });
    const text = await response.text();
    if (!response.ok) {
      const detail = `SimCloud control ${path} returned ${response.status}: ${text.slice(0, 8192)}`;
      try { appendFileSync(ERROR_LOG, `${new Date().toISOString()} ${detail}\n`); } catch {}
      throw new Error(detail);
    }
    return JSON.parse(text);
  }
  function jobPath(request, suffix) {
    const jobId = jobsByLease.get(request.leaseId);
    if (!jobId) throw new Error(`No claimed job is mapped for lease ${request.leaseId}`);
    return `/api/uniscenario/internal/render-jobs/${encodeURIComponent(jobId)}/${suffix}`;
  }
  return {
    register: (request, signal) => post("/api/uniscenario/internal/workers/register", request, signal),
    async claim(request, signal) { const response = await post("/api/uniscenario/internal/render-jobs/lease", request, signal); if (response.lease?.leaseId && response.jobId) { jobsByLease.set(response.lease.leaseId, response.jobId); } return response; },
    heartbeat: (request, signal) => post(jobPath(request, "heartbeat"), request, signal),
    progress: (request, signal) => post(jobPath(request, "events"), request, signal),
    reserveArtifact: (request, signal) => post(jobPath(request, "artifacts"), request, signal),
    complete: (request, signal) => post(jobPath(request, "complete"), request, signal),
    fail: (request, signal) => { try { appendFileSync(ERROR_LOG, `${new Date().toISOString()} failure code=${request.failure?.code ?? "unknown"} retryable=${request.failure?.retryable ?? false} message=${request.failure?.message ?? ""}\n`); } catch {} return post(jobPath(request, "fail"), request, signal); },
    async drain(request) { return { schema: CONTROL_SCHEMA, type: "worker.draining", registrationId: request.registrationId }; },
  };
}
