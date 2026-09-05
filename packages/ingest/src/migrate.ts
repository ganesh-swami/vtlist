/**
 * Applying supabase/migrations/*.sql over a direct Postgres connection.
 *
 * The Supabase JS client cannot run DDL, so this uses the database password
 * (SUPABASE_DB_URL, or SUPABASE_DB_PASSWORD plus the project ref) instead of an
 * API key. Files are applied in filename order, each as a single statement
 * batch; a file whose first line says "-- optional:" may fail without stopping
 * the run.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

function connectionString(): string {
  if (process.env.SUPABASE_DB_URL) return process.env.SUPABASE_DB_URL;

  const password = process.env.SUPABASE_DB_PASSWORD;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!password || !url) {
    throw new Error(
      "Set SUPABASE_DB_URL, or SUPABASE_DB_PASSWORD (Supabase → Project Settings\n" +
        "→ Database → Database password) alongside NEXT_PUBLIC_SUPABASE_URL, in .env.local.",
    );
  }
  const ref = new URL(url).hostname.split(".")[0];
  return `postgresql://postgres:${encodeURIComponent(password)}@db.${ref}.supabase.co:5432/postgres`;
}

export async function migrate(dir: string) {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  if (!files.length) {
    console.log("No migrations found.");
    return;
  }

  const client = new pg.Client({
    connectionString: connectionString(),
    // Supabase terminates TLS with its own CA; the password still travels
    // encrypted, which is what matters here.
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000,
  });
  await client.connect();
  try {
    for (const file of files) {
      const sql = await readFile(path.join(dir, file), "utf8");
      const optional = sql.trimStart().startsWith("-- optional:");
      try {
        await client.query(sql);
        console.log(`  applied ${file}`);
      } catch (err) {
        const message = (err as Error).message;
        if (optional) console.warn(`  skipped ${file} (optional): ${message}`);
        else throw new Error(`${file}: ${message}`);
      }
    }
  } finally {
    await client.end();
  }
}
