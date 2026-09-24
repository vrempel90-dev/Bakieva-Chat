import type { Pool, PoolClient } from "pg";

export async function acquireSingletonLock(
  pool: Pick<Pool, "connect">,
  lockId: number,
  signal: AbortSignal,
  wait: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms))
): Promise<PoolClient> {
  while (!signal.aborted) {
    const client = await pool.connect();
    try {
      const result = await client.query("SELECT pg_try_advisory_lock($1) AS locked", [lockId]);
      if (result.rows[0]?.locked) {
        if (signal.aborted) {
          await client.query("SELECT pg_advisory_unlock($1)", [lockId]);
          throw new Error("Shutdown during lock acquisition");
        }
        return client;
      }
    } catch (error) {
      client.release();
      throw error;
    }
    client.release();
    await wait(2000);
  }
  throw new Error("Shutdown before singleton lock");
}
