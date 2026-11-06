import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "pg";

type MigrationDatabase = {
  exec(sql: string): Promise<unknown>;
  query<T = Record<string, unknown>>(sql: string, args?: unknown[]): Promise<{ rows: T[] }>;
  close(): Promise<void>;
};

/** Default to embedded PostgreSQL. Opt in to a disposable native local database. */
export async function migrationDatabase(): Promise<MigrationDatabase> {
  const connectionString = process.env.SHIFTLY_TEST_DATABASE_URL;
  if (!connectionString) return new PGlite();
  const url = new URL(connectionString);
  assert.ok(
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname),
    "Native migration tests require a disposable local PostgreSQL cluster.",
  );
  const database = `shiftly_upgrade_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString });
  await admin.connect();
  await admin.query(`create database "${database}"`);
  url.pathname = `/${database}`;
  const client = new Client({ connectionString: url.toString() });
  try {
    await client.connect();
  } catch (error) {
    await client.end().catch(() => {});
    await admin.query(`drop database "${database}"`);
    await admin.end();
    throw error;
  }
  return {
    async exec(sql: string) {
      // Auth roles are cluster-wide on native PostgreSQL, unlike PGlite fixtures.
      return client.query(
        sql.replace(
          /create role (anon|authenticated|service_role);/gi,
          (_, role) =>
            `do $$begin create role ${role};exception when duplicate_object then null;end$$;`,
        ),
      );
    },
    async query<T = Record<string, unknown>>(
      sql: string,
      args: unknown[] = [],
    ): Promise<{ rows: T[] }> {
      const { rows } = await client.query(sql, args);
      return { rows: rows as unknown as T[] };
    },
    async close() {
      await client.query("rollback").catch(() => {});
      await client.end();
      try {
        await admin.query(`drop database "${database}"`);
      } finally {
        await admin.end();
      }
    },
  };
}
