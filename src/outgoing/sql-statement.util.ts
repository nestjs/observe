const MAX_STATEMENT_LENGTH = 2048;
const MAX_IDENTIFIER_LENGTH = 64;

/**
 * Where each verb names the table it works on. `WITH` and anything unlisted
 * falls through to the verb alone - a wrong table is worse than none.
 */
const TABLE_AFTER: Record<string, RegExp> = {
  SELECT: /\bFROM\s+([\w."`[\]]+)/i,
  DELETE: /\bFROM\s+([\w."`[\]]+)/i,
  INSERT: /\bINTO\s+([\w."`[\]]+)/i,
  REPLACE: /\bINTO\s+([\w."`[\]]+)/i,
  UPDATE: /^\s*UPDATE\s+(?:ONLY\s+)?([\w."`[\]]+)/i,
};

export interface SqlStatementDescription {
  /**
   * A low-cardinality label: the verb and the table, `SELECT users`. It names
   * the span, so it is also what repeated queries collapse under and what the
   * per-method aggregates group by - one row per kind of query, not one per
   * distinct WHERE clause.
   */
  operation: string;
  /** The statement with every literal replaced, safe to leave the process. */
  statement: string;
}

/**
 * Strips a SQL statement of its values.
 *
 * Bound parameters never reach this function - only the text does - but
 * applications interpolate, and an interpolated statement carries its data in
 * its literals. Every string, number and IN-list is replaced, so what is
 * shipped is the statement's shape. Comments go too: ORMs and query taggers
 * put request ids and user ids in them.
 */
export function describeSqlStatement(sql: string): SqlStatementDescription {
  const statement = sql
    .slice(0, MAX_STATEMENT_LENGTH * 4)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    // Dollar-quoted (Postgres), then single-quoted with doubled-quote and
    // backslash escapes. Double quotes and backticks are identifiers - kept.
    .replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, "?")
    .replace(/'(?:[^'\\]|\\.|'')*'/g, "?")
    // A number that is not part of an identifier or a `$1` placeholder.
    .replace(/(?<![\w$])-?\d+(?:\.\d+)?(?:e[+-]?\d+)?(?![\w])/gi, "?")
    .replace(/\(\s*\?(?:\s*,\s*\?)+\s*\)/g, "(?)")
    .replace(/\(\s*\$\d+(?:\s*,\s*\$\d+)+\s*\)/g, "($n)")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_STATEMENT_LENGTH);

  const verb = /^[\s(]*([A-Za-z]+)/.exec(statement)?.[1]?.toUpperCase();
  if (!verb) {
    return { operation: "QUERY", statement };
  }
  const table = TABLE_AFTER[verb]
    ?.exec(statement)?.[1]
    ?.replace(/["`[\]]/g, "")
    .slice(0, MAX_IDENTIFIER_LENGTH);
  return { operation: table ? `${verb} ${table}` : verb, statement };
}
