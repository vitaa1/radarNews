import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

// Executa SQL real com as migrações do projeto. Não simula os limites do runtime
// Cloudflare; os testes contam também fetches e injetam falhas explicitamente.
export function sqliteDatabase(migrationCount = Infinity) {
  const sqlite = new DatabaseSync(":memory:");
  const directory = new URL("../../migrations/", import.meta.url);
  for (const file of readdirSync(directory).filter((name) => name.endsWith(".sql")).sort().slice(0, migrationCount)) {
    sqlite.exec(readFileSync(new URL(file, directory), "utf8"));
  }
  const state = {
    sqlite,
    calls: 0,
    beforeQuery: (_sql: string): void => {},
    DB: null as unknown as D1Database,
  };
  state.DB = {
    prepare(sql: string) {
      let bindings: Record<string, SQLInputValue> = {};
      const execute = () => {
        state.calls += 1;
        state.beforeQuery(sql);
        return sqlite.prepare(sql);
      };
      const statement = {
        bind(...values: SQLInputValue[]) {
          bindings = Object.fromEntries(values.map((value, i) => [`?${i + 1}`, value]));
          return statement;
        },
        async first() { return execute().get(bindings) ?? null; },
        async all() { return { results: execute().all(bindings) }; },
        async run() { return { meta: { changes: Number(execute().run(bindings).changes) } }; },
      };
      return statement as unknown as D1PreparedStatement;
    },
  } as unknown as D1Database;
  return state;
}
