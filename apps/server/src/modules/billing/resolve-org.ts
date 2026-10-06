import type { TabulaDb } from "@tabula/db";
import { sql } from "kysely";
import { parsePid } from "../../lib/public-ids.js";
import { PublicIdError } from "../../http/errors.js";

export async function resolveBillingOrgId(
  db: TabulaDb,
  userId: string,
  orgPublicId?: string,
): Promise<string | null> {
  if (orgPublicId) {
    let orgId: string;
    try {
      orgId = parsePid(orgPublicId, "org");
    } catch {
      throw new PublicIdError("Invalid organization id");
    }

    const member = await sql<{ org_id: string }>`
      SELECT org_id FROM core.organization_members
      WHERE org_id = ${orgId} AND user_id = ${userId} AND status = 'active'
      LIMIT 1
    `.execute(db);

    return member.rows[0]?.org_id ?? null;
  }

  const member = await sql<{ org_id: string }>`
    SELECT org_id FROM core.organization_members
    WHERE user_id = ${userId} AND status = 'active'
    ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
             joined_at ASC
    LIMIT 1
  `.execute(db);

  return member.rows[0]?.org_id ?? null;
}
