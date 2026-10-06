import { generateUuidV7 } from "@tabula/types";
import type { TabulaDb } from "@tabula/db";
import { sql, type Transaction } from "kysely";
import type { Database } from "@tabula/db";

type DbExecutor = TabulaDb | Transaction<Database>;

export async function createFreeSubscriptionInTx(
  trx: DbExecutor,
  orgId: string,
): Promise<void> {
  const existing = await sql<{ id: string }>`
    SELECT id FROM core.subscriptions
    WHERE org_id = ${orgId}
      AND status IN ('trialing', 'active', 'past_due', 'paused')
    LIMIT 1
  `.execute(trx);

  if (existing.rows[0]) {
    return;
  }

  const subId = generateUuidV7();
  await sql`
    INSERT INTO core.subscriptions (id, org_id, plan_id, status)
    SELECT ${subId}, ${orgId}, p.id, 'active'
    FROM core.plans p
    WHERE p.code = 'free'
    LIMIT 1
  `.execute(trx);
}

export async function upgradeOrgToTeamPlan(
  db: TabulaDb,
  orgId: string,
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const teamPlan = await sql<{ id: string }>`
      SELECT id FROM core.plans WHERE code = 'team' LIMIT 1
    `.execute(trx);

    const planId = teamPlan.rows[0]?.id;
    if (!planId) {
      throw new Error("TEAM_PLAN_NOT_SEEDED");
    }

    const active = await sql<{ id: string }>`
      SELECT id FROM core.subscriptions
      WHERE org_id = ${orgId}
        AND status IN ('trialing', 'active', 'past_due', 'paused')
      ORDER BY created_at DESC
      LIMIT 1
    `.execute(trx);

    const subId = active.rows[0]?.id ?? generateUuidV7();
    if (active.rows[0]) {
      await sql`
        UPDATE core.subscriptions
        SET plan_id = ${planId}, status = 'active', updated_at = now()
        WHERE id = ${subId}
      `.execute(trx);
    } else {
      await sql`
        INSERT INTO core.subscriptions (id, org_id, plan_id, status)
        VALUES (${subId}, ${orgId}, ${planId}, 'active')
      `.execute(trx);
    }
  });
}
