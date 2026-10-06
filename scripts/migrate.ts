import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { defaultDbPath } from "../lib/db";
import { migrate } from "../lib/db/migrate";

const file = defaultDbPath();
fs.mkdirSync(path.dirname(file), { recursive: true });
const sqlite = new Database(file);
migrate(sqlite);
sqlite.close();
console.log(`Migrated ${file}`);
