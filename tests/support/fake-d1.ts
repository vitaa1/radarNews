export interface RecordedStatement {
  sql: string;
  bindings: unknown[];
}

export interface StatementBehavior {
  first?: unknown;
  results?: unknown[] | undefined;
  changes?: number | undefined;
  error?: Error | undefined;
}

export function fakeDatabase(
  behaviors: StatementBehavior[],
  statements: RecordedStatement[],
): D1Database {
  return databaseWithFactory(statements, () => behaviors.shift() ?? {});
}

interface SqlBehavior {
  first?: (sql: string, bindings: unknown[]) => unknown;
  results?: (sql: string, bindings: unknown[]) => unknown[];
  changes?: (sql: string, bindings: unknown[]) => number;
  error?: (sql: string, bindings: unknown[]) => Error | undefined;
}

export function databaseBySql(
  behavior: SqlBehavior,
  statements: RecordedStatement[],
): D1Database {
  return databaseWithFactory(statements, (sql, bindings) => ({
    first: behavior.first?.(sql, bindings),
    results: behavior.results?.(sql, bindings),
    changes: behavior.changes?.(sql, bindings),
    error: behavior.error?.(sql, bindings),
  }));
}

function databaseWithFactory(
  statements: RecordedStatement[],
  behaviorFor: (sql: string, bindings: unknown[]) => StatementBehavior,
): D1Database {
  return {
    prepare(sql: string) {
      const record: RecordedStatement = { sql, bindings: [] };
      statements.push(record);
      let resolvedBehavior: StatementBehavior | undefined;
      const currentBehavior = () => {
        resolvedBehavior ??= behaviorFor(sql, record.bindings);
        return resolvedBehavior;
      };
      const statement = {
        bind(...values: unknown[]) {
          record.bindings = values;
          return statement;
        },
        async first<T>() {
          const behavior = currentBehavior();
          if (behavior.error) throw behavior.error;
          return (behavior.first ?? null) as T | null;
        },
        async all<T>() {
          const behavior = currentBehavior();
          if (behavior.error) throw behavior.error;
          return { results: (behavior.results ?? []) as T[] };
        },
        async run() {
          const behavior = currentBehavior();
          if (behavior.error) throw behavior.error;
          return { meta: { changes: behavior.changes ?? 0 } };
        },
      };
      return statement as unknown as D1PreparedStatement;
    },
  } as unknown as D1Database;
}
