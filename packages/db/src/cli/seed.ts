import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { seedDefaultShard, seedPlans } from "../seed.js";

const envPath = resolve(process.cwd(), "../../.env");
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
} else if (existsSync(resolve(process.cwd(), ".env"))) {
  process.loadEnvFile(resolve(process.cwd(), ".env"));
}

const connectionString = process.env["DATABASE_URL"];
if (!connectionString) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

await seedPlans(connectionString);
const shardId = await seedDefaultShard({ connectionString });
console.log(`Seeded plans and default shard ${shardId}`);
