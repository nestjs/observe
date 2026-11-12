import { errorMonitor, EventEmitter } from "node:events";
import { OutgoingSpanRecorder } from "./outgoing-span.recorder.js";
import { patchMethod } from "./patch-method.util.js";
import {
  describeSanitizedSqlStatement,
  SqlStatementDescription,
} from "./sql-statement.util.js";

interface MssqlModule {
  Request?: { prototype?: object };
}

interface MssqlRequest extends EventEmitter {
  parent?: {
    config?: { options?: { enableQuotedIdentifier?: boolean | null } };
    /** Set when the parent is a `PreparedStatement`: what it was prepared with. */
    statement?: unknown;
    unprepare?: unknown;
  };
}

/**
 * The procedures a `PreparedStatement` calls on requests of its own: the
 * driver parents those requests to the statement and executes these by name.
 */
const PREPARED_STATEMENT_PROCEDURES = new Set([
  "sp_prepare",
  "sp_execute",
  "sp_unprepare",
]);

function describeMssqlStatement(
  sql: string,
  enableQuotedIdentifier: boolean,
  redactExecArgs = true,
): { operation: string; statement?: string } {
  const input = sql.slice(0, 8192);
  const truncated = sql.length > input.length;
  let text = "";
  // T-SQL escapes quotes by doubling them, not with backslashes. Tokenizing
  // first keeps comment markers inside strings and identifiers inert.
  // Double quotes follow connection options; SQL SET overrides are not tracked.
  // Binary literals may continue across lines after a backslash.
  const tokenPattern =
    /(?<comment>--[^\r\n]*)|\[(?:[^\]]|\]\])*(?:\]|$)|(?<quoted>"(?:[^"]|"")*(?:"|$))|(?<literal>N?'(?:[^']|'')*(?:'|$)|(?<![\w@])\$\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)|\b0x[\da-f]*(?:\\(?:\r\n|\r|\n)[\da-f]*)*|(?<![\w$@])-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?(?![\w]))|[^]/giy;
  for (let index = 0; index < input.length; ) {
    if (input.startsWith("/*", index)) {
      let depth = 1;
      index += 2;
      while (index < input.length && depth) {
        if (input.startsWith("/*", index)) {
          depth++;
          index += 2;
        } else if (input.startsWith("*/", index)) {
          depth--;
          index += 2;
        } else {
          index++;
        }
      }
      text += " ";
      continue;
    }
    tokenPattern.lastIndex = index;
    const token = tokenPattern.exec(input)!;
    index = tokenPattern.lastIndex;
    if (token.groups?.comment !== undefined) {
      text += " ";
    } else if (
      token.groups?.literal !== undefined ||
      (!enableQuotedIdentifier && token.groups?.quoted !== undefined)
    ) {
      text += "?";
    } else {
      text += token[0];
    }
  }
  if (truncated) {
    // Anchored at the run's start. Unanchored, the engine tried every position
    // inside each run of word characters and backtracked the run each time:
    // quadratic, 0.1 s of a blocked event loop for one 8 KB name. The sign is
    // a number cut between its exponent's sign and digits, `987654e+`, which
    // the tokenizer could not read as a number and left as text.
    text = text.replace(
      /(^|[^\p{L}\p{M}\p{N}_$@#])[\p{L}\p{M}\p{N}_$@#]+[+-]?$/u,
      "$1?",
    );
  }
  // `;WITH` is how T-SQL is often written, to end whatever came before.
  text = text.replace(/^[\s;]+/, "");
  if (!CAPTURED_STATEMENT.test(text)) {
    const verb = /^[\s(]*([A-Za-z]+)/.exec(text)?.[1]?.toUpperCase();
    return { operation: verb ?? "QUERY" };
  }
  return nameProcedureCall(
    describeSanitizedSqlStatement(
      redactExecArgs ? redactExecArguments(text) : text,
    ),
  );
}

/**
 * Names a procedure call after its procedure, `EXEC dbo.GetOrders`, with
 * quotes and brackets dropped as from a table name - the same row whether it
 * came through `execute()` or an `EXEC` batch, and a row per procedure rather
 * than one `EXEC` for all of them.
 */
function nameProcedureCall(
  description: SqlStatementDescription,
): SqlStatementDescription {
  const exec = /^EXEC(?:UTE)?(?=\s|$)/i.exec(description.statement);
  if (!exec) {
    return description;
  }
  const name = EXEC_TARGET.exec(
    description.statement.slice(exec[0].length),
  )?.[1]
    .replace(/\s*\.\s*/g, ".")
    .replace(/["[\]]/g, "");
  return {
    ...description,
    operation: (name ? `EXEC ${name}` : "EXEC").slice(0, 64),
  };
}

/**
 * A batch may open with a procedure call without EXEC, and its unquoted
 * arguments look like keywords. Statement text is kept only for batches
 * opening with a reserved word that starts a statement: a reserved word cannot
 * name a procedure unquoted, so such a batch is never a call in disguise.
 * Non-reserved statement words (`THROW`, `RECEIVE`, `SEND`) can, and are left
 * out.
 */
const CAPTURED_STATEMENT =
  /^[\s(]*(?:SELECT|INSERT|UPDATE|DELETE|MERGE|WITH|EXEC|EXECUTE|SET|DECLARE|IF|WHILE|BEGIN|COMMIT|ROLLBACK|SAVE|TRUNCATE|CREATE|ALTER|DROP|USE|PRINT|RAISERROR|WAITFOR|GRANT|REVOKE|DENY|RETURN|OPEN|CLOSE|FETCH|DEALLOCATE|BREAK|CONTINUE|GOTO|KILL|DBCC|BACKUP|RESTORE|CHECKPOINT|RECONFIGURE|BULK|SETUSER|REVERT|SHUTDOWN|READTEXT|WRITETEXT|UPDATETEXT)(?![\p{L}\p{M}\p{N}\p{Pc}@$#])/iu;

/**
 * What follows `EXEC`: an optional `@status =`, then the procedure's dotted
 * name, each part bracketed, double-quoted or bare.
 */
const EXEC_TARGET =
  /^\s+(?:@[\p{L}_][\p{L}\p{M}\p{N}\p{Pc}@$#]*\s*=\s*)?((?:\[(?:[^\]]|\]\])*\]|"(?:[^"]|"")*"|[\p{L}_@#][\p{L}\p{M}\p{N}\p{Pc}@$#]*)(?:\s*\.\s*(?:\[(?:[^\]]|\]\])*\]|"(?:[^"]|"")*"|[\p{L}_@#][\p{L}\p{M}\p{N}\p{Pc}@$#]*))*)/u;

function findExec(source: string, start: number) {
  for (let index = start; index < source.length; ) {
    if (source[index] === "[" || source[index] === '"') {
      const opening = source[index];
      const closing = opening === "[" ? "]" : '"';
      index++;
      while (index < source.length) {
        if (source[index] === closing) {
          if (source[index + 1] === closing) {
            index += 2;
            continue;
          }
          index++;
          break;
        }
        index++;
      }
      continue;
    }
    const match = /^EXEC(?:UTE)?\b/i.exec(source.slice(index));
    if (
      match &&
      (index === 0 || !/[\w@$#]/.test(source[index - 1])) &&
      !/[\w@$#]/.test(source[index + match[0].length] ?? "")
    ) {
      return { index, length: match[0].length };
    }
    index++;
  }
  return undefined;
}

/**
 * The number of a procedure in a group, `EXEC dbo.Activate;2 'key'` - by now
 * usually `;?`, or a digit a word runs on from. The call goes on after it: no
 * statement opens with either, so this `;` cannot be the end of one.
 */
const PROCEDURE_NUMBER = /;\s*[?\d]/y;

function redactExecArguments(sql: string): string {
  let text = sql;
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const exec = findExec(text, searchFrom);
    if (!exec) {
      break;
    }
    let end = exec.index + exec.length;
    let inBracket = false;
    let inQuotedIdentifier = false;
    while (end < text.length) {
      if (inBracket) {
        if (text[end] === "]" && text[end + 1] === "]") {
          end += 2;
          continue;
        }
        if (text[end] === "]") inBracket = false;
      } else if (inQuotedIdentifier) {
        if (text[end] === '"' && text[end + 1] === '"') {
          end += 2;
          continue;
        }
        if (text[end] === '"') inQuotedIdentifier = false;
      } else if (text[end] === "[") {
        inBracket = true;
      } else if (text[end] === '"') {
        inQuotedIdentifier = true;
      } else if (text[end] === ";") {
        PROCEDURE_NUMBER.lastIndex = end;
        if (!PROCEDURE_NUMBER.test(text)) {
          break;
        }
      }
      end++;
    }

    const tail = text.slice(exec.index + exec.length, end);
    const procedure = EXEC_TARGET.exec(tail)?.[0] ?? "";
    // Only what follows the procedure is an argument: `EXEC dbo.Refresh`
    // has none to replace.
    if (tail.slice(procedure.length).trim()) {
      const prefix = text.slice(
        exec.index,
        exec.index + exec.length + procedure.length,
      );
      text = `${text.slice(0, exec.index)}${prefix} ?${text.slice(end)}`;
      searchFrom = exec.index + prefix.length + 2;
    } else {
      searchFrom = end + 1;
    }
  }
  return text;
}

/**
 * These internal boundaries follow template expansion and precede pool
 * checkout. The tedious driver's `_batch` delegates to `_query`.
 */
export function patchMssql(
  mssql: MssqlModule,
  recorder: OutgoingSpanRecorder,
): boolean {
  const wrap = (method: string) => (original: (...args: any[]) => any) =>
    function (this: MssqlRequest, ...args: any[]) {
      const [command, callback] = args;
      // Asked first: describing a statement means tokenizing it, which an
      // untraced or sampled-out call should not pay for.
      if (
        typeof command !== "string" ||
        typeof callback !== "function" ||
        !recorder.isRecording()
      ) {
        return original.apply(this, args);
      }
      let sql = command;
      let procedure = method === "_execute";
      if (
        procedure &&
        typeof this.parent?.unprepare === "function" &&
        PREPARED_STATEMENT_PROCEDURES.has(command)
      ) {
        // Preparing and unpreparing are the statement's bookkeeping, and
        // `sp_execute` would name every prepared statement alike: the span is
        // the statement it executes, described like any other query.
        const prepared = this.parent.statement;
        if (command !== "sp_execute" || typeof prepared !== "string") {
          return original.apply(this, args);
        }
        sql = prepared;
        procedure = false;
      }
      // Names in double quotes only where the driver turns the setting on:
      // its default and `true`. `null` sends no SET, and the session keeps
      // the server's own setting, which is OFF as installed - there a double
      // quote opens a string.
      const quotedIdentifier =
        this.parent?.config?.options?.enableQuotedIdentifier;
      const { operation, statement } = describeMssqlStatement(
        procedure ? `EXEC ${sql}` : sql,
        quotedIdentifier === undefined || quotedIdentifier === true,
        !procedure,
      );
      const span = recorder.open(
        "mssql",
        operation,
        statement === undefined
          ? { "db.system": "mssql" }
          : { "db.system": "mssql", "db.statement": statement },
      );
      if (!span) {
        return original.apply(this, args);
      }
      let streamError: unknown;
      const onError = (error: unknown) => {
        streamError ??= error;
      };
      // Observe streaming errors without swallowing unhandled error events.
      this.on(errorMonitor, onError);
      const finish = (error: unknown) => {
        this.removeListener(errorMonitor, onError);
        span.end(error ?? streamError);
      };
      args[1] = function (this: unknown, error: unknown, ...rest: any[]) {
        finish(error);
        return callback.call(this, error, ...rest);
      };
      try {
        return original.apply(this, args);
      } catch (error) {
        finish(error);
        throw error;
      }
    };

  const patched = ["_query", "_execute"].map((method) =>
    patchMethod(mssql.Request?.prototype, method, wrap(method)),
  );
  return patched.some(Boolean);
}
