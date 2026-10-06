import { createLogger } from "@tabula/observability";

const log = createLogger({ name: "tabula-scheduler", role: "scheduler" });

/** MVP stub — leader-elected cron (partition maintenance, reconciler) in Wave A step 20. */
log.info("Scheduler role stub started");

setInterval(() => {
  // Keep process alive for role orchestration smoke tests.
}, 60_000);
