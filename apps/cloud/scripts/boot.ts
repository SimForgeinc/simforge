import { spawn } from "node:child_process";
import { migrate } from "./migrate";
import { seed } from "./seed";

await migrate();
await seed();

const child = spawn("pnpm", ["exec", "next", "dev", "-p", process.env.PORT ?? "5199"], {
  stdio: "inherit",
  env: process.env,
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => child.kill(signal));
}

const exitCode = await new Promise<number>((resolve) => {
  child.once("exit", (code) => resolve(code ?? 1));
});
process.exit(exitCode);
