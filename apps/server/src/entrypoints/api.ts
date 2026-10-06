import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createApp } from "../composition/create-app.js";

const rootEnv = resolve(process.cwd(), "../../.env");
const localEnv = resolve(process.cwd(), ".env");
if (existsSync(rootEnv)) {
  process.loadEnvFile(rootEnv);
} else if (existsSync(localEnv)) {
  process.loadEnvFile(localEnv);
}

const { app, ctx } = await createApp();

try {
  await app.listen({ port: ctx.env.PORT, host: "0.0.0.0" });
  ctx.log.info({ port: ctx.env.PORT }, "Tabula API listening");
} catch (err) {
  ctx.log.error({ err }, "Failed to start API");
  process.exit(1);
}
