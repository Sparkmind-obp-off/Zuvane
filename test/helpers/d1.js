// Minimal Cloudflare D1 shim on node:sqlite. Applies the real migrations in order,
// enforces foreign keys like D1, and runs batch() inside a transaction.
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");
const isReader = (sql) => /^\s*(SELECT|WITH|PRAGMA)/i.test(sql) || /\bRETURNING\b/i.test(sql);

class Statement {
  constructor(db, sql, values = []) { this.db = db; this.sql = sql; this.values = values; }
  bind(...values) {
    for (const v of values) if (v === undefined || typeof v === "boolean" || (typeof v === "object" && v !== null)) throw new TypeError(`D1_TYPE_ERROR: unsupported bind value ${typeof v} in ${this.sql.slice(0, 60)}`);
    return new Statement(this.db, this.sql, values);
  }
  _exec() {
    const stmt = this.db.raw.prepare(this.sql);
    if (isReader(this.sql)) {
      const results = stmt.all(...this.values);
      return { results, success: true, meta: { changes: /\bRETURNING\b/i.test(this.sql) ? results.length : 0 } };
    }
    const info = stmt.run(...this.values);
    return { results: [], success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
  }
  async first(column) { const row = this._exec().results[0] ?? null; return column && row ? row[column] : row; }
  async all() { return this._exec(); }
  async run() { return this._exec(); }
}

export class D1Shim {
  constructor({ upTo = Infinity } = {}) {
    this.raw = new DatabaseSync(":memory:");
    this.raw.exec("PRAGMA foreign_keys = ON;");
    this.applied = [];
    for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
      if (Number.parseInt(file, 10) > upTo) break;
      this.raw.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
      this.applied.push(file);
    }
  }
  migrateRemaining() {
    for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
      if (this.applied.includes(file)) continue;
      this.raw.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
      this.applied.push(file);
    }
  }
  prepare(sql) { return new Statement(this, sql); }
  async batch(statements) {
    this.raw.exec("BEGIN");
    try {
      const out = statements.map((s) => s._exec());
      this.raw.exec("COMMIT");
      return out;
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
    }
  }
  async exec(sql) { this.raw.exec(sql); return { count: 1 }; }
}
