import { spawn, type ChildProcess } from "node:child_process";
import { migrate } from "./migrate";
import { seed } from "./seed";
import { simforgeEnv } from "../lib/compat-env";

await migrate();
await seed();

const children: ChildProcess[] = [];

const server = spawn("pnpm", ["exec", "next", "dev", "--webpack", "-p", process.env.PORT ?? "5199"], {
  stdio: "inherit",
  env: process.env,
});
children.push(server);

const withWorker =
  process.env.SIMFORGE_LOCAL_WORKER === "1" || process.argv.includes("--with-worker");
if (withWorker) {
  const port = process.env.PORT ?? "5199";
  const worker = spawn("pnpm", ["exec", "tsx", "worker/index.ts"], {
    stdio: "inherit",
    env: {
      ...process.env,
      SIMFORGE_API_BASE_URL:
        simforgeEnv("API_BASE_URL") ?? `http://127.0.0.1:${port}`,
    },
  });
  children.push(worker);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    for (const child of children) child.kill(signal);
  });
}

const exitCode = await new Promise<number>((resolve) => {
  server.once("exit", (code) => resolve(code ?? 1));
});
for (const child of children) {
  if (child !== server) child.kill("SIGTERM");
}
process.exit(exitCode);
