import { Database } from "bun:sqlite";
import { readFileSync } from "fs";
import { resolve } from "path";
import { config } from "./config";

let db: Database | null = null;

export function getDb(): Database {
  if (!db) {
    const dbPath = resolve(config.dataDir, "openflux.db");
    db = new Database(dbPath, { create: true });
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    runMigrations(db);
  }
  return db;
}

function runMigrations(database: Database) {
  database.exec(
    "CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))"
  );

  const migrationDir = resolve(import.meta.dir, "../migrations");
  const files = ["001_init.sql", "002_hardening.sql", "003_x402.sql", "004_fix_x402_indexes.sql"];

  for (const file of files) {
    const applied = database
      .query("SELECT 1 FROM _migrations WHERE name = ?")
      .get(file);
    if (applied) continue;

    database.exec("BEGIN IMMEDIATE");
    try {
      if (file === "003_x402.sql") {
        applyMigration003(database);
      } else {
        const sql = readFileSync(resolve(migrationDir, file), "utf-8");
        database.exec(sql);
      }
      database
        .query("INSERT INTO _migrations (name) VALUES (?)")
        .run(file);
      database.exec("COMMIT");
      console.log(`[db] Applied migration: ${file}`);
    } catch (e) {
      database.exec("ROLLBACK");
      throw e;
    }
  }
}

function applyMigration003(database: Database) {
  const columns = database.query("PRAGMA table_info(content)").all() as { name: string }[];
  const hasPriceUsdc = columns.some((c) => c.name === "price_usdc");
  if (!hasPriceUsdc) {
    database.exec("ALTER TABLE content ADD COLUMN price_usdc INTEGER");
  }

  // Deduplicate historical purchase rows before adding unique constraint.
  database.exec(`
    DELETE FROM ledger
    WHERE reason = 'content_purchase_x402'
      AND rowid NOT IN (
        SELECT MIN(rowid)
        FROM ledger
        WHERE reason = 'content_purchase_x402'
        GROUP BY pubkey, ref_id
      )
  `);

  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_unique_x402_purchase
      ON ledger(pubkey, ref_id, reason)
      WHERE reason = 'content_purchase_x402'
  `);
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_ledger_x402_sale_lookup
      ON ledger(pubkey, ref_id, reason)
      WHERE reason = 'content_sale_x402'
  `);
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}
