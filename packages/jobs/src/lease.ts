/** Fields shared by Postgres-backed durable job rows using lease-based claiming. */

export interface LeaseFields {
  leaseUntil: Date | null;
  status: string;
}
