import type { TabulaDb } from "@tabula/db";
import { sql } from "kysely";

export interface PlanLimits {
  recordsPerBase?: number;
  attachmentBytesPerBase?: number;
  tablesPerBase?: number;
  [key: string]: unknown;
}

export interface OrgPlanSnapshot {
  planCode: string;
  planName: string;
  limits: PlanLimits;
}

export interface OrgUsageSnapshot {
  recordsByBase: Record<string, number>;
  attachmentBytesByBase: Record<string, number>;
}

export class PlanLimitExceededError extends Error {
  constructor(
    message: string,
    readonly meta?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "PlanLimitExceededError";
  }
}

export class LimitsService {
  constructor(private readonly db: TabulaDb) {}

  async getOrgPlan(orgId: string): Promise<OrgPlanSnapshot> {
    const row = await sql<{
      code: string;
      name: string;
      limits: PlanLimits;
    }>`
      SELECT p.code, p.name, p.limits
      FROM core.subscriptions s
      INNER JOIN core.plans p ON p.id = s.plan_id
      WHERE s.org_id = ${orgId}
        AND s.status IN ('trialing', 'active', 'past_due', 'paused')
      ORDER BY s.created_at DESC
      LIMIT 1
    `.execute(this.db);

    const sub = row.rows[0];
    if (sub) {
      return {
        planCode: sub.code,
        planName: sub.name,
        limits: sub.limits ?? {},
      };
    }

    const free = await sql<{ code: string; name: string; limits: PlanLimits }>`
      SELECT code, name, limits FROM core.plans WHERE code = 'free' LIMIT 1
    `.execute(this.db);

    const plan = free.rows[0];
    return {
      planCode: plan?.code ?? "free",
      planName: plan?.name ?? "Free",
      limits: plan?.limits ?? { recordsPerBase: 2000 },
    };
  }

  async getUsage(orgId: string): Promise<OrgUsageSnapshot> {
    const bases = await sql<{ base_id: string; record_count: string }>`
      SELECT br.base_id, br.record_count
      FROM data.base_runtime br
      INNER JOIN core.base_directory bd ON bd.base_id = br.base_id
      WHERE bd.org_id = ${orgId} AND bd.deleted_at IS NULL
    `.execute(this.db);

    const attachments = await sql<{ base_id: string; total: string }>`
      SELECT a.base_id, COALESCE(SUM(a.size_bytes), 0)::text AS total
      FROM data.attachments a
      INNER JOIN core.base_directory bd ON bd.base_id = a.base_id
      WHERE bd.org_id = ${orgId}
        AND bd.deleted_at IS NULL
      GROUP BY a.base_id
    `.execute(this.db);

    const recordsByBase: Record<string, number> = {};
    for (const b of bases.rows) {
      recordsByBase[b.base_id] = Number(b.record_count);
    }

    const attachmentBytesByBase: Record<string, number> = {};
    for (const a of attachments.rows) {
      attachmentBytesByBase[a.base_id] = Number(a.total);
    }

    return { recordsByBase, attachmentBytesByBase };
  }

  async assertCanCreateRecord(
    orgId: string,
    baseId: string,
    additionalRecords = 1,
  ): Promise<void> {
    const plan = await this.getOrgPlan(orgId);
    const limit = plan.limits.recordsPerBase;
    if (limit === undefined || additionalRecords <= 0) {
      return;
    }

    const countRow = await sql<{ record_count: string }>`
      SELECT record_count FROM data.base_runtime WHERE base_id = ${baseId} LIMIT 1
    `.execute(this.db);

    const current = Number(countRow.rows[0]?.record_count ?? 0);
    if (current + additionalRecords > limit) {
      throw new PlanLimitExceededError(
        `Record limit for this base is ${limit} on the ${plan.planName} plan`,
        {
          metric: "recordsPerBase",
          limit,
          current,
          requested: additionalRecords,
          plan: plan.planCode,
        },
      );
    }
  }

  async assertAttachmentBytes(
    orgId: string,
    baseId: string,
    additionalBytes: number,
  ): Promise<void> {
    if (additionalBytes <= 0) {
      return;
    }

    const plan = await this.getOrgPlan(orgId);
    const limit = plan.limits.attachmentBytesPerBase;
    if (limit === undefined) {
      return;
    }

    const usage = await this.getUsage(orgId);
    const current = usage.attachmentBytesByBase[baseId] ?? 0;
    if (current + additionalBytes > limit) {
      throw new PlanLimitExceededError(
        `Attachment storage limit for this base is ${limit} bytes on the ${plan.planName} plan`,
        {
          metric: "attachmentBytesPerBase",
          limit,
          current,
          requested: additionalBytes,
          plan: plan.planCode,
        },
      );
    }
  }
}
