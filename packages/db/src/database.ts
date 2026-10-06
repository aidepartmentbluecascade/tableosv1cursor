import type { ColumnType, Generated } from "kysely";

/** Use `db.withSchema('core' | 'data')` when querying. */
export interface Database {
  organizations: CoreOrganizations;
  users: CoreUsers;
  shards: CoreShards;
  workspaces: CoreWorkspaces;
  workspace_directory: CoreWorkspaceDirectory;
  base_directory: CoreBaseDirectory;
  plans: CorePlans;
  subscriptions: CoreSubscriptions;
  invitations: CoreInvitations;
  usage_counters: CoreUsageCounters;
  bases: DataBases;
  base_runtime: DataBaseRuntime;
  tables: DataTables;
  fields: DataFields;
  deletion_batches: DataDeletionBatches;
  long_operations: DataLongOperations;
  link_relations: DataLinkRelations;
}

export interface CoreOrganizations {
  id: Generated<string>;
  name: string;
  slug: string;
  kind: string;
  status: string;
  data_region: string;
  settings: ColumnType<Record<string, unknown>, Record<string, unknown>, Record<string, unknown>>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface CoreUsers {
  id: Generated<string>;
  email: string;
  email_normalized: string;
  display_name: string;
  status: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface CoreShards {
  id: Generated<string>;
  name: string;
  region: string;
  status: string;
  dsn_secret_ref: string;
  writer_endpoint: string;
  reader_endpoints: string[];
  pg_major_version: number;
  capacity_weight: number;
  workspace_count: number;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface CoreWorkspaces {
  id: Generated<string>;
  org_id: string;
  name: string;
  status: string;
  settings: ColumnType<Record<string, unknown>, Record<string, unknown>, Record<string, unknown>>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface CoreWorkspaceDirectory {
  workspace_id: string;
  org_id: string;
  shard_id: string;
  status: string;
  migration_epoch: number;
  region: string;
  updated_at: Generated<Date>;
}

export interface CoreBaseDirectory {
  base_id: string;
  workspace_id: string;
  org_id: string;
  shard_id: string;
  kind: string;
  name: string;
  status: string;
  order_key: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface CorePlans {
  id: Generated<string>;
  code: string;
  name: string;
  limits: ColumnType<Record<string, unknown>, Record<string, unknown>, Record<string, unknown>>;
  created_at: Generated<Date>;
}

export interface CoreSubscriptions {
  id: Generated<string>;
  org_id: string;
  plan_id: string;
  status: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  seats: number;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface CoreInvitations {
  id: Generated<string>;
  org_id: string;
  email: string;
  resource_type: string;
  resource_id: string;
  role: string;
  token_hash: Buffer;
  invited_by: string;
  status: string;
  expires_at: Date;
  created_at: Generated<Date>;
}

export interface CoreUsageCounters {
  org_id: string;
  metric: string;
  period_start: Date;
  value: Generated<number>;
}

export interface DataBases {
  id: Generated<string>;
  workspace_id: string;
  kind: string;
  name: string;
  schema_version: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface DataBaseRuntime {
  base_id: string;
  workspace_id: string;
  change_seq: Generated<number>;
  perm_epoch: Generated<number>;
  schema_version: Generated<number>;
  updated_at: Generated<Date>;
}

export interface DataTables {
  id: Generated<string>;
  workspace_id: string;
  base_id: string;
  name: string;
  restrictions: ColumnType<Record<string, unknown>, Record<string, unknown>, Record<string, unknown>>;
}

export interface DataFields {
  id: Generated<string>;
  workspace_id: string;
  base_id: string;
  table_id: string;
  slot: number;
  name: string;
  type: string;
  restrictions: ColumnType<Record<string, unknown>, Record<string, unknown>, Record<string, unknown>>;
  index_state: Generated<string>;
}

export interface DataDeletionBatches {
  id: Generated<string>;
  workspace_id: string;
  base_id: string | null;
  created_by: string | null;
  created_at: Generated<Date>;
  restored_at: Date | null;
}

export interface DataLongOperations {
  id: Generated<string>;
  workspace_id: string;
  base_id: string | null;
  kind: string;
  status: string;
  progress: ColumnType<Record<string, unknown>, Record<string, unknown>, Record<string, unknown>>;
  checkpoint: ColumnType<Record<string, unknown>, Record<string, unknown>, Record<string, unknown>>;
  lease_until: Date | null;
  error: string | null;
  created_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  completed_at: Date | null;
}

export interface DataLinkRelations {
  id: Generated<string>;
  workspace_id: string;
  base_id: string;
  a_table_id: string;
  a_field_id: string;
  b_table_id: string;
  b_field_id: string | null;
  allow_multiple_a: boolean;
  allow_multiple_b: boolean;
  created_at: Generated<Date>;
}
