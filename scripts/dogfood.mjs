#!/usr/bin/env node
/**
 * Local dogfood: Docker infra + migrate/seed + all Tabula dev processes.
 * Cross-platform (Node 22+). Ctrl+C stops spawned children.
 */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const composeFile = join(root, "infra/docker/docker-compose.yml");
const isWin = process.platform === "win32";
const pnpm = isWin ? "pnpm.cmd" : "pnpm";

/** @type {import('node:child_process').ChildProcess[]} */
const children = [];

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: root,
      stdio: "inherit",
      shell: isWin,
      env: process.env,
      ...opts,
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(undefined);
      else reject(new Error(`${cmd} ${args.join(" ")} exited ${code}`));
    });
  });
}

function spawnDev(name, script) {
  const child = spawn(pnpm, ["run", script], {
    cwd: root,
    stdio: "inherit",
    shell: isWin,
    env: { ...process.env, FORCE_COLOR: "1" },
  });
  child.on("error", (err) => {
    console.error(`[dogfood] failed to start ${name}:`, err.message);
  });
  children.push(child);
  console.log(`[dogfood] started ${name} (${script})`);
}

async function dockerComposeUp() {
  const services = ["postgres", "redis"];
  const baseArgs = ["compose", "-f", composeFile, "up", "-d", ...services];
  try {
    await run("docker", [...baseArgs, "--wait"]);
  } catch {
    console.warn("[dogfood] `docker compose --wait` failed; continuing with manual wait");
    await run("docker", baseArgs);
  }
  await waitForInfra();
}

async function waitForInfra(maxMs = 120_000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const [pg, redis] = await Promise.all([
        tcpProbe("127.0.0.1", 5432),
        tcpProbe("127.0.0.1", 6379),
      ]);
      if (pg && redis) {
        console.log("[dogfood] infra ready (postgres, redis)");
        return;
      }
    } catch {
      /* retry */
    }
    await sleep(2000);
  }
  throw new Error("Timed out waiting for postgres/redis");
}

function tcpProbe(host, port) {
  return new Promise((resolve) => {
    import("node:net").then(({ connect }) => {
      const socket = connect({ host, port }, () => {
        socket.destroy();
        resolve(true);
      });
      socket.on("error", () => resolve(false));
      socket.setTimeout(2000, () => {
        socket.destroy();
        resolve(false);
      });
    });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function ensureEnv() {
  const envPath = join(root, ".env");
  const example = join(root, ".env.example");
  if (!existsSync(envPath) && existsSync(example)) {
    copyFileSync(example, envPath);
    console.log("[dogfood] copied .env.example → .env");
  }
}

function shutdown() {
  for (const child of children) {
    if (!child.killed) {
      if (isWin) spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { shell: true });
      else child.kill("SIGTERM");
    }
  }
}

async function main() {
  ensureEnv();
  console.log("[dogfood] starting Docker infra…");
  await dockerComposeUp();

  console.log("[dogfood] installing dependencies…");
  await run(pnpm, ["install"]);

  console.log("[dogfood] building workspace packages…");
  await run(pnpm, ["run", "build"]);

  console.log("[dogfood] migrate + seed…");
  await run(pnpm, ["run", "db:migrate"]);
  await run(pnpm, ["run", "db:seed"]);

  const services = [
    ["API", "dev:api"],
    ["Realtime", "dev:realtime"],
    ["Worker", "dev:worker"],
    ["Relay", "dev:relay"],
    ["Web", "dev:web"],
    ["Public", "dev:public"],
  ];
  console.log("[dogfood] starting app processes (Ctrl+C to stop)…");
  for (const [name, script] of services) spawnDev(name, script);

  process.on("SIGINT", () => {
    console.log("\n[dogfood] shutting down…");
    shutdown();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    shutdown();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("[dogfood]", err.message ?? err);
  shutdown();
  process.exit(1);
});
