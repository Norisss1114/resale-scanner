import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';

export function testDb() {
  const db = new DatabaseSync(':memory:');
  const root = new URL('../migrations/', import.meta.url);
  for (const file of readdirSync(root).filter(f => f.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(file, root), 'utf8'));
  const adapter = {
    raw: db,
    prepare(sql) {
      const stmt = db.prepare(sql); let args = [];
      return {
        bind(...values) { args = values; return this; },
        async first() { return stmt.get(...args) || null; },
        async all() { return { results: stmt.all(...args) }; },
        async run() { return { success: true, meta: { changes: Number(stmt.run(...args).changes) } }; }
      };
    },
    async batch(statements) {
      db.exec('BEGIN');
      try { const results = []; for (const stmt of statements) results.push(await stmt.run()); db.exec('COMMIT'); return results; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    }
  };
  return adapter;
}
