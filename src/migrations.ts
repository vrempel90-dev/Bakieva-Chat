import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type pg from "pg";

export async function runMigrations(
  client: Pick<pg.PoolClient, "query">,
  directory: string,
) {
  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock(424201001)");
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    for (const name of (await readdir(directory))
      .filter((n) => /^\d+_.*\.sql$/.test(n))
      .sort()) {
      const sql = (await readFile(join(directory, name), "utf8")).replace(
        /\r\n/g,
        "\n",
      );
      const checksum = createHash("sha256").update(sql).digest("hex");
      const prior = await client.query(
        "SELECT checksum FROM schema_migrations WHERE name=$1",
        [name],
      );
      if (prior.rowCount) {
        if (prior.rows[0].checksum !== checksum)
          throw new Error(`Migration changed: ${name}`);
        continue;
      }
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)",
        [name, checksum],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
