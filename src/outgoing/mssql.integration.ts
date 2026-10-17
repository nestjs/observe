import { errorMonitor, EventEmitter } from "node:events";
import { OutgoingSpanRecorder } from "./outgoing-span.recorder.js";
import { patchMethod } from "./patch-method.util.js";
import { describeSanitizedSqlStatement } from "./sql-statement.util.js";

interface MssqlModule {
  Request?: { prototype?: object };
}

interface MssqlRequest extends EventEmitter {
  parent?: {
    config?: { options?: { enableQuotedIdentifier?: boolean | null } };
  };
}

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
    text = text.replace(/[\p{L}\p{M}\p{N}_$@#]+$/u, "?");
  }
  const description = describeSanitizedSqlStatement(
    redactExecArgs ? redactExecArguments(text) : text,
  );
  if (CAPTURED_STATEMENT.test(text)) {
    return description;
  }
  const verb = /^[\s(]*([A-Za-z]+)/.exec(text)?.[1]?.toUpperCase();
  return { operation: verb ?? "QUERY" };
}

/**
 * A batch may open with a procedure call without EXEC, and its unquoted
 * arguments look like keywords. Statement text is kept only for batches
 * opening with these reserved words, which cannot name such a procedure.
 */
const CAPTURED_STATEMENT =
  /^[\s(]*(?:SELECT|INSERT|UPDATE|DELETE|MERGE|WITH|EXEC|EXECUTE)(?![\p{L}\p{M}\p{N}\p{Pc}@$#])/iu;

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
        break;
      }
      end++;
    }

    const tail = text.slice(exec.index + exec.length, end);
    const procedure =
      /^\s+(?:@[A-Za-z_]\w*\s*=\s*)?(?:\[(?:[^\]]|\]\])*\]|"(?:[^"]|"")*"|[A-Za-z_@$#][\w@$#]*)(?:\s*\.\s*(?:\[(?:[^\]]|\]\])*\]|"(?:[^"]|"")*"|[A-Za-z_@$#][\w@$#]*))*/.exec(
        tail,
      );
    if (tail.trim()) {
      const prefix = procedure
        ? text.slice(exec.index, exec.index + exec.length + procedure[0].length)
        : text.slice(exec.index, exec.index + exec.length);
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
      if (typeof command !== "string" || typeof callback !== "function") {
        return original.apply(this, args);
      }
      const { operation, statement } = describeMssqlStatement(
        method === "_execute" ? `EXEC ${command}` : command,
        this.parent?.config?.options?.enableQuotedIdentifier !== false,
        method !== "_execute",
      );
      const span = recorder.open(
        "mssql",
        method === "_execute"
          ? (statement ?? operation).slice(0, 64)
          : operation,
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
