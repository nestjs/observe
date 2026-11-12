const MAX_STATEMENT_LENGTH = 2048;
const MAX_IDENTIFIER_LENGTH = 64;

/**
 * Where each verb names the table it works on. `WITH` and anything unlisted
 * falls through to the verb alone - a wrong table is worse than none.
 */
const TABLE_AFTER: Record<string, RegExp> = {
  SELECT: /\bFROM\s+(?:ONLY\s+)?([\w."`[\]]+)/i,
  DELETE: /\bFROM\s+(?:ONLY\s+)?([\w."`[\]]+)/i,
  INSERT: /\bINTO\s+([\w."`[\]]+)/i,
  REPLACE: /\bINTO\s+([\w."`[\]]+)/i,
  UPDATE: /^\s*UPDATE\s+(?:ONLY\s+)?([\w."`[\]]+)/i,
};

/**
 * Words that put a table or a subquery, not a function's arguments, in the
 * parenthesis after them.
 */
const NOT_A_FUNCTION = new Set([
  "ALL",
  "AND",
  "ANY",
  "AS",
  "EXCEPT",
  "EXISTS",
  "FROM",
  "IN",
  "INTERSECT",
  "JOIN",
  "LATERAL",
  "NOT",
  "ON",
  "OR",
  "SELECT",
  "SOME",
  "UNION",
  "USING",
  "VALUES",
  "WHERE",
  "WITH",
]);

/** Whether the parenthesis at `index` opens a function's arguments. */
function opensArguments(statement: string, index: number): boolean {
  let end = index;
  if (statement[end - 1] === " ") {
    end--;
  }
  let start = end;
  while (start > 0 && /[\w$]/.test(statement[start - 1])) {
    start--;
  }
  return (
    start < end &&
    /^[A-Za-z_]/.test(statement[start]) &&
    !NOT_A_FUNCTION.has(statement.slice(start, end).toUpperCase())
  );
}

/**
 * `statement` with what a function's arguments hold left out:
 * `EXTRACT(EPOCH FROM created_at)` and `TRIM(BOTH ' ' FROM name)` have a
 * `FROM` that is an argument, not the table. A parenthesis counts as one when
 * a name comes right before it. One after `FROM` or `JOIN` - a derived table,
 * a subquery, a parenthesised join - is kept as it is. Only what a function
 * holds is taken out, so every `FROM` left is followed by what followed it
 * before. One pass, so it stays linear however deeply the parentheses nest.
 */
function withoutFunctionArguments(statement: string): string {
  let text = "";
  let copied = 0;
  // How deep inside a function's arguments `index` is, 0 outside any.
  let depth = 0;
  for (let index = 0; index < statement.length; index++) {
    const char = statement[index];
    if (char === "(") {
      if (depth) {
        depth++;
      } else if (opensArguments(statement, index)) {
        text += statement.slice(copied, index);
        copied = index;
        depth = 1;
      }
    } else if (char === ")" && depth && !--depth) {
      text += "()";
      copied = index + 1;
    }
  }
  // Arguments that never close are kept as they are.
  return text + statement.slice(copied);
}

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

/** The SQL a driver speaks, which decides what its quotes and comments mean. */
export type SqlDialect = "postgresql" | "mysql";

/**
 * Comments, quoted names and literals, found left to right: a comment marker
 * inside a string, or a quote inside a comment or a name, is part of the token
 * it is in. Each runs to the end of the input when nothing closes it. Names
 * are kept, comments become a space and literals `?`.
 *
 * Postgres quotes names in `"`. A plain string takes a backslash as it is and
 * an `E'...'` string as an escape. A dollar quote opens only where a token
 * can start - Postgres reads `a$b$` as one name - and block comments nest, so
 * `/*` is matched alone and its end found by hand.
 *
 * MySQL quotes strings in `"` as well as `'`, as its default sql_mode does
 * (under ANSI_QUOTES a `"` name goes too), with backslash escapes in both -
 * NO_BACKSLASH_ESCAPES is not assumed - and `#` starts a comment. `--` does
 * only before whitespace or a control character, as MySQL reads it:
 * `credit--5` is `credit - -5`, and the rest of its line is still SQL, quotes
 * and all. Its block comments do not nest.
 */
const TOKEN: Record<SqlDialect, RegExp> = {
  postgresql:
    /(?<nested>\/\*)|(?<comment>--[^\n]*)|(?<name>"(?:[^"]|"")*(?:"|$)|`(?:[^`]|``)*(?:`|$))|(?<![\w$])(?<escape>[eE])'(?:[^'\\]|\\[\s\S]?|'')*(?:'|$)|(?<plain>'(?:[^']|'')*(?:'|$))|(?<!\w)\$(?<tag>[A-Za-z_]*)\$[\s\S]*?(?:\$\k<tag>\$|$)/g,
  mysql:
    // eslint-disable-next-line no-control-regex -- MySQL's rule for `--`.
    /(?<comment>\/\*[\s\S]*?(?:\*\/|$)|--(?=[\u0000-\u0020\u007f]|$)[^\n]*|#[^\n]*)|(?<name>`(?:[^`]|``)*(?:`|$))|'(?:[^'\\]|\\[\s\S]?|'')*(?:'|$)|"(?:[^"\\]|\\[\s\S]?|"")*(?:"|$)/g,
};

function stripLiteralsAndComments(sql: string, dialect: SqlDialect): string {
  const token = TOKEN[dialect];
  token.lastIndex = 0;
  let text = "";
  let index = 0;
  for (let match; (match = token.exec(sql)); index = token.lastIndex) {
    text += sql.slice(index, match.index);
    const { nested, comment, name, escape, plain } = match.groups!;
    if (nested !== undefined) {
      token.lastIndex = endOfNestedComment(sql, token.lastIndex);
      text += " ";
    } else if (comment !== undefined) {
      text += " ";
    } else if (name !== undefined) {
      text += name;
    } else if (plain !== undefined && /(?<!\\)(?:\\\\)*\\'/.test(plain)) {
      // An odd run of backslashes before a quote: with
      // standard_conforming_strings off, the quote does not end the string
      // here, so where it does end is unknown - and so is everything after.
      return `${text}?`;
    } else {
      text += `${escape ?? ""}?`;
    }
  }
  return text + sql.slice(index);
}

/** Where a Postgres block comment opened before `index` ends. */
function endOfNestedComment(sql: string, index: number): number {
  for (let depth = 1; depth && index < sql.length; ) {
    if (sql.startsWith("/*", index)) {
      depth++;
      index += 2;
    } else if (sql.startsWith("*/", index)) {
      depth--;
      index += 2;
    } else {
      index++;
    }
  }
  return index;
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
export function describeSqlStatement(
  sql: string,
  dialect: SqlDialect,
): SqlStatementDescription {
  const input = sql.slice(0, MAX_STATEMENT_LENGTH * 4);
  let sanitized = stripLiteralsAndComments(input, dialect)
    // A number that is not part of an identifier or a `$1` placeholder: hex,
    // binary and octal too, and digits grouped with `_` (Postgres 16).
    .replace(
      /(?<![\w$])(?:0x[\da-f_]+|0b[01_]+|0o[0-7_]+|-?\d[\d_]*(?:\.[\d_]+)?(?:e[+-]?\d[\d_]*)?)(?![\w])/gi,
      "?",
    );
  if (sql.length > input.length) {
    // The bound may have cut a number short - `987654e+` is no longer one -
    // so whatever word it cut goes too. Anchored at the run's start, which
    // keeps it linear on a run 8 KB long.
    sanitized = sanitized.replace(
      /(^|[^\p{L}\p{M}\p{N}_$])[\p{L}\p{M}\p{N}_$]+[+-]?$/u,
      "$1?",
    );
  }
  return describeSanitizedSqlStatement(sanitized);
}

/** Names and bounds SQL whose literals and comments have already been removed. */
export function describeSanitizedSqlStatement(
  sql: string,
): SqlStatementDescription {
  const statement = sql
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
    ?.exec(withoutFunctionArguments(statement))?.[1]
    ?.replace(/["`[\]]/g, "")
    .slice(0, MAX_IDENTIFIER_LENGTH);
  return { operation: table ? `${verb} ${table}` : verb, statement };
}
