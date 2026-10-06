import type { Database } from "@tabula/db";
import {
  buildFieldGraph,
  type FieldDependencyGraph,
  type FieldDependencyEdge,
} from "@tabula/compute";
import { sql, type Transaction } from "kysely";

type DbTrx = Transaction<Database>;

export interface ComputeFieldRow {
  id: string;
  tableId: string;
  slot: number;
  name: string;
  type: string;
  config: Record<string, unknown>;
  isComputed: boolean;
}

export interface LinkRelationRow {
  id: string;
  aTableId: string;
  aFieldId: string;
  bTableId: string;
  bFieldId: string | null;
  allowMultipleA: boolean;
  allowMultipleB: boolean;
}

export interface BaseComputeSchema {
  fields: ComputeFieldRow[];
  fieldsById: Map<string, ComputeFieldRow>;
  fieldsByTable: Map<string, ComputeFieldRow[]>;
  slotToField: Map<string, Map<string, ComputeFieldRow>>;
  graph: FieldDependencyGraph;
  linkRelations: LinkRelationRow[];
  linkRelationByFieldId: Map<string, LinkRelationRow & { side: "a" | "b" }>;
}

export async function loadBaseComputeSchema(
  trx: DbTrx,
  baseId: string,
): Promise<BaseComputeSchema> {
  const fieldRows = await sql<{
    id: string;
    table_id: string;
    slot: number;
    name: string;
    type: string;
    config: unknown;
    is_computed: boolean;
  }>`
    SELECT id, table_id, slot, name, type, config, is_computed
    FROM data.fields
    WHERE base_id = ${baseId} AND deleted_at IS NULL
  `.execute(trx);

  const fields: ComputeFieldRow[] = fieldRows.rows.map((r) => ({
    id: r.id,
    tableId: r.table_id,
    slot: r.slot,
    name: r.name,
    type: r.type,
    config: (r.config ?? {}) as Record<string, unknown>,
    isComputed: r.is_computed,
  }));

  const fieldsById = new Map(fields.map((f) => [f.id, f]));
  const fieldsByTable = new Map<string, ComputeFieldRow[]>();
  const slotToField = new Map<string, Map<string, ComputeFieldRow>>();

  for (const f of fields) {
    const list = fieldsByTable.get(f.tableId) ?? [];
    list.push(f);
    fieldsByTable.set(f.tableId, list);

    const slotMap = slotToField.get(f.tableId) ?? new Map();
    slotMap.set(String(f.slot), f);
    slotToField.set(f.tableId, slotMap);
  }

  const depRows = await sql<{
    dependent_field_id: string;
    depends_on_field_id: string;
    via_link_field_id: string | null;
  }>`
    SELECT dependent_field_id, depends_on_field_id, via_link_field_id
    FROM data.field_dependencies
    WHERE base_id = ${baseId}
  `.execute(trx);

  const edges: FieldDependencyEdge[] = depRows.rows.map((r) => ({
    dependentFieldId: r.dependent_field_id,
    dependsOnFieldId: r.depends_on_field_id,
    viaLinkFieldId: r.via_link_field_id,
  }));

  const graph = buildFieldGraph(
    fields.map((f) => f.id),
    edges,
  );

  const relRows = await sql<{
    id: string;
    a_table_id: string;
    a_field_id: string;
    b_table_id: string;
    b_field_id: string | null;
    allow_multiple_a: boolean;
    allow_multiple_b: boolean;
  }>`
    SELECT id, a_table_id, a_field_id, b_table_id, b_field_id,
           allow_multiple_a, allow_multiple_b
    FROM data.link_relations
    WHERE base_id = ${baseId}
  `.execute(trx);

  const linkRelations: LinkRelationRow[] = relRows.rows.map((r) => ({
    id: r.id,
    aTableId: r.a_table_id,
    aFieldId: r.a_field_id,
    bTableId: r.b_table_id,
    bFieldId: r.b_field_id,
    allowMultipleA: r.allow_multiple_a,
    allowMultipleB: r.allow_multiple_b,
  }));

  const linkRelationByFieldId = new Map<
    string,
    LinkRelationRow & { side: "a" | "b" }
  >();
  for (const rel of linkRelations) {
    linkRelationByFieldId.set(rel.aFieldId, { ...rel, side: "a" });
    if (rel.bFieldId) {
      linkRelationByFieldId.set(rel.bFieldId, { ...rel, side: "b" });
    }
  }

  return {
    fields,
    fieldsById,
    fieldsByTable,
    slotToField,
    graph,
    linkRelations,
    linkRelationByFieldId,
  };
}
