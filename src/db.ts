import { DatabaseSync } from "node:sqlite";
import { config } from "./config.js";

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (!db) {
    db = new DatabaseSync(config.db.path);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS cases (
        id         TEXT PRIMARY KEY,
        paris_top  TEXT,
        paris_back TEXT,
        bcn_top    TEXT,
        bcn_back   TEXT,
        resolved   TEXT DEFAULT NULL,
        confirmed  INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL
      )
    `);
    try { db.exec("ALTER TABLE cases ADD COLUMN confirmed INTEGER DEFAULT 0"); } catch (_) {}
  }
  return db;
}

export function upsertCase(
  id: string,
  data: {
    parisTop?: object | null;
    parisBack?: object | null;
    bcnTop?: object | null;
    bcnBack?: object | null;
    resolved?: string | null;
    confirmed?: boolean;
  },
) {
  getDb().prepare(`
    INSERT INTO cases (id, paris_top, paris_back, bcn_top, bcn_back, resolved, confirmed, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      paris_top  = CASE WHEN excluded.paris_top  IS NOT NULL THEN excluded.paris_top  ELSE paris_top  END,
      paris_back = CASE WHEN excluded.paris_back IS NOT NULL THEN excluded.paris_back ELSE paris_back END,
      bcn_top    = CASE WHEN excluded.bcn_top    IS NOT NULL THEN excluded.bcn_top    ELSE bcn_top    END,
      bcn_back   = CASE WHEN excluded.bcn_back   IS NOT NULL THEN excluded.bcn_back   ELSE bcn_back   END,
      resolved   = CASE WHEN excluded.resolved   IS NOT NULL THEN excluded.resolved   ELSE resolved   END,
      confirmed  = CASE WHEN excluded.confirmed = 1 THEN 1 ELSE confirmed END
  `).run(
    id,
    data.parisTop ? JSON.stringify(data.parisTop) : null,
    data.parisBack ? JSON.stringify(data.parisBack) : null,
    data.bcnTop ? JSON.stringify(data.bcnTop) : null,
    data.bcnBack ? JSON.stringify(data.bcnBack) : null,
    data.resolved ?? null,
    data.confirmed ? 1 : 0,
    Date.now(),
  );
}

// Used when a resolved/confirmed session receives a fresh message — clears the
// case back to a clean slate rather than leaving stale resolved/confirmed values
// that upsertCase's null-coalescing writes can never overwrite.
export function resetCase(id: string) {
  getDb().prepare(`
    UPDATE cases SET paris_top = NULL, paris_back = NULL, bcn_top = NULL, bcn_back = NULL, resolved = NULL, confirmed = 0
    WHERE id = ?
  `).run(id);
}
