import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "./migrate";
import * as schema from "./schema";

export type DB = BetterSQLite3Database<typeof schema> & { $client: Database.Database };
export { schema };

/** Create a migrated Drizzle DB. Use ":memory:" in tests. */
export function createDb(file: string = defaultDbPath()): DB {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new Database(file);
  if (file !== ":memory:") sqlite.pragma("journal_mode = WAL");
  migrate(sqlite);
  return drizzle(sqlite, { schema });
}

export function defaultDbPath(): string {
  return process.env.DATABASE_PATH ?? path.join(process.cwd(), "data", "council.db");
}

const g = globalThis as unknown as { __councilDb?: DB };

/** Process-wide DB singleton (survives dev hot reload). */
export function getDb(): DB {
  return (g.__councilDb ??= createDb());
}
