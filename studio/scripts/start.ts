import { spawn } from "node:child_process";
import { migrate } from "./migrate";
import { seed } from "./seed";

// Production boot: same migrations and seed as `dev` (scripts/boot.ts), then
// serve the output of `next build`.
await migrate();
await seed();

const server = spawn(
  "pnpm",
  ["exec", "next", "start", "-p", process.env.PORT ?? "5199", "-H", process.env.HOSTNAME ?? "127.0.0.1"],
  { stdio: "inherit", env: process.env },
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.kill(signal));
}

const exitCode = await new Promise<number>((resolve) => {
  server.once("exit", (code) => resolve(code ?? 1));
});
process.exit(exitCode);
