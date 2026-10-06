import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../lib/app-context.js";
import { registerAttachmentsRoutes } from "../attachments/routes.js";
import { registerCommentsRoutes } from "../comments/routes.js";
import { registerContactsRoutes } from "../contacts/routes.js";
import { registerImportExportRoutes } from "../import-export/routes.js";
import { registerNotificationsRoutes } from "../notifications/routes.js";
import { registerSearchRoutes } from "../search/routes.js";
import { registerShareRoutes } from "../share/routes.js";

/** Wave 4 collaboration HTTP surface (Postgres + S3 backends). */
export async function registerWave4Routes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  await registerAttachmentsRoutes(app, ctx);
  await registerCommentsRoutes(app, ctx);
  await registerNotificationsRoutes(app, ctx);
  await registerSearchRoutes(app, ctx);
  await registerShareRoutes(app, ctx);
  await registerImportExportRoutes(app, ctx);
  await registerContactsRoutes(app, ctx);
}
