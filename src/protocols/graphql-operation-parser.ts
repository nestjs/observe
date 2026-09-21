import { GraphQLResolveInfoLike } from "../interfaces/index.js";

/**
 * Reads the operation out of a GraphQL document, without parsing it.
 *
 * The request-lifecycle hooks hand this module a query *string*, and
 * everything the module labels a trace with - the operation id, and the
 * `GraphQLResolveInfo`-shaped `info` the `graphql` options are called with -
 * is derived from it here.
 *
 * `graphql`'s own `parse` is deliberately not used. It is an optional peer, it
 * builds a full AST, and the server is about to do exactly that anyway: this
 * runs on every operation, so it stops at the first field of the first
 * operation definition and never looks at the rest of the document.
 */

/** Operation keywords, mapped to the root type each one resolves against. */
const ROOT_TYPE_BY_KEYWORD: Record<string, string> = {
  query: "Query",
  mutation: "Mutation",
  subscription: "Subscription",
};

/**
 * Parsed results are cached: a client sends the same handful of documents over
 * and over, and re-scanning each one per request is pure waste. Bounded in
 * both dimensions because the key is attacker-supplied: the entry count stops
 * a client sending unique documents from growing the map without limit, and
 * the per-entry size stops 512 entries from being 512 multi-megabyte strings.
 * A document past the size cap is still parsed, just not remembered - a
 * client that sends one is not a client whose documents repeat.
 */
const CACHE_LIMIT = 512;
const MAX_CACHEABLE_DOCUMENT_LENGTH = 16 * 1024;
const cache = new Map<string, ParsedGraphQLOperation | undefined>();

/**
 * Cap on the document shape a trace records.
 *
 * `sanitizedDocument` travels as the snapshot's `originalUrl`, and a query is
 * a request body, not a URL: nothing upstream bounds its size the way the
 * HTTP parser bounds a header. Left uncapped, one multi-megabyte document
 * from an unauthenticated client overflows the shared buffer and takes every
 * other trace, metric and log in that batch down with it. Same order of size
 * as the log-entry cap, for the same reason: past this a document is no
 * longer something a reader scans, and the collector indexes it by trigram.
 */
const MAX_SANITIZED_DOCUMENT_LENGTH = 8 * 1024;
const TRUNCATION_SUFFIX = "... [truncated by observe]";

export interface ParsedGraphQLOperation {
  /** The root type the operation resolves against - `Query`, `Mutation`, `Subscription`. */
  rootTypeName: string;
  /** The first root field the document selects, e.g. `orders`. */
  fieldName: string;
  /** The operation's name, when the document gave it one. */
  operationName?: string;
  /**
   * The document with comments dropped, string and number literals blanked to
   * `_`, and whitespace collapsed. What a trace records as the shape of the
   * request: stable across formatting, and stripped of the token kinds that
   * carry user data inline.
   */
  sanitizedDocument: string;
}

/**
 * Builds the `GraphQLResolveInfo`-shaped object the `graphql` options receive.
 *
 * It is genuinely synthetic - there is no single field being resolved when the
 * whole operation is the unit of measurement - but it carries the same values
 * a root field's real info would, which is the shape `ignore` and
 * `setAttributes` are written against.
 */
export function toResolveInfoLike(
  operation: Pick<
    ParsedGraphQLOperation,
    "rootTypeName" | "fieldName" | "operationName"
  >,
): GraphQLResolveInfoLike {
  return {
    fieldName: operation.fieldName,
    parentType: { name: operation.rootTypeName },
    operation: {
      operation: operation.rootTypeName.toLowerCase(),
      name: operation.operationName
        ? { value: operation.operationName }
        : undefined,
    },
  };
}

/**
 * Finds the first operation definition in a document and its first root field.
 *
 * Returns `undefined` for anything it cannot label with confidence - a document
 * whose first selection is a fragment spread, or one that does not parse as far
 * as a selection set. Callers fall back to the operation name, and failing that
 * leave the operation uninstrumented.
 */
export function parseGraphQLOperation(
  document: string | undefined,
): ParsedGraphQLOperation | undefined {
  if (!document) {
    return undefined;
  }

  if (cache.has(document)) {
    return cache.get(document);
  }
  const parsed = scan(document);
  if (document.length > MAX_CACHEABLE_DOCUMENT_LENGTH) {
    return parsed;
  }
  if (cache.size >= CACHE_LIMIT) {
    // Oldest entry out. Map iterates in insertion order, so this is the least
    // recently *added* document rather than the least recently used one - close
    // enough for a cache whose job is to absorb a client's fixed set of queries.
    cache.delete(cache.keys().next().value as string);
  }
  cache.set(document, parsed);
  return parsed;
}

/** Test seam: the cache is process-wide and would leak between cases. */
export function clearGraphQLOperationCache(): void {
  cache.clear();
}

/** Test seam: what the cache holds is otherwise unobservable from outside. */
export function graphQLOperationCacheSize(): number {
  return cache.size;
}

function scan(document: string): ParsedGraphQLOperation | undefined {
  const source = stripIgnoredTokens(document);
  const words: string[] = [];
  let index = 0;

  while (index < source.length) {
    const char = source[index];

    if (isNameStart(char)) {
      const start = index;
      while (index < source.length && isNameChar(source[index])) {
        index += 1;
      }
      words.push(source.slice(start, index));
      continue;
    }

    // A directive's name is not part of the definition's header - `query @live`
    // must not read `live` as the operation name.
    if (char === "@") {
      index += 1;
      while (index < source.length && isNameChar(source[index])) {
        index += 1;
      }
      continue;
    }

    // Variable definitions, with default values that may themselves contain
    // braces: `query Q($filter: F = { paid: true })`.
    if (char === "(") {
      index = skipBalanced(source, index, "(", ")");
      continue;
    }

    if (char === "{") {
      if (words[0] === "fragment") {
        // A fragment may precede the operation it is used by. Skip its body and
        // keep looking for a definition that is one.
        index = skipBalanced(source, index, "{", "}");
        words.length = 0;
        continue;
      }
      return toOperation(words, readFirstFieldName(source, index + 1), source);
    }

    index += 1;
  }

  return undefined;
}

function toOperation(
  words: string[],
  fieldName: string | undefined,
  source: string,
): ParsedGraphQLOperation | undefined {
  if (!fieldName) {
    return undefined;
  }
  // Shorthand - `{ orders { id } }` - has no keyword at all and is a query.
  const keyword = words[0] ? words[0].toLowerCase() : "query";
  const rootTypeName = ROOT_TYPE_BY_KEYWORD[keyword];
  if (!rootTypeName) {
    return undefined;
  }
  return {
    rootTypeName,
    fieldName,
    operationName: words[0] ? words[1] : undefined,
    // Whitespace is collapsed only here, at the end: `source` positions have to
    // stay valid while the scan is still reading from it.
    sanitizedDocument: truncate(source.replace(/\s+/g, " ").trim()),
  };
}

function truncate(document: string): string {
  if (document.length <= MAX_SANITIZED_DOCUMENT_LENGTH) {
    return document;
  }
  return (
    document.slice(
      0,
      MAX_SANITIZED_DOCUMENT_LENGTH - TRUNCATION_SUFFIX.length,
    ) + TRUNCATION_SUFFIX
  );
}

/**
 * Reads the first field selected inside a selection set, seeing through an
 * alias: `latest: orders` is a selection of `orders`, and that is the name a
 * resolver's info would have reported.
 */
function readFirstFieldName(source: string, from: number): string | undefined {
  let index = from;

  while (index < source.length) {
    const char = source[index];

    if (isNameStart(char)) {
      const start = index;
      while (index < source.length && isNameChar(source[index])) {
        index += 1;
      }
      const name = source.slice(start, index);

      let lookahead = index;
      while (lookahead < source.length && isIgnored(source[lookahead])) {
        lookahead += 1;
      }
      if (source[lookahead] === ":") {
        // An alias: the selected field is the next name. Iteration, not
        // recursion - the document is caller-supplied, and a long enough run
        // of colons must cost a loop pass each, never a stack frame each.
        index = lookahead + 1;
        continue;
      }
      return name;
    }

    // A fragment spread or inline fragment first: the field is defined
    // elsewhere in the document, and chasing it is not worth an AST.
    if (char === "." || char === "}") {
      return undefined;
    }

    index += 1;
  }

  return undefined;
}

/**
 * Blanks out comments, strings and numbers, so none can be mistaken for a name
 * or a brace. Offsets are not preserved - nothing downstream maps back to the
 * original text.
 */
function stripIgnoredTokens(document: string): string {
  let out = "";
  let index = 0;

  while (index < document.length) {
    const char = document[index];

    if (char === "#") {
      while (index < document.length && document[index] !== "\n") {
        index += 1;
      }
      continue;
    }

    if (char === '"') {
      if (document.startsWith('"""', index)) {
        const end = document.indexOf('"""', index + 3);
        index = end === -1 ? document.length : end + 3;
      } else {
        index += 1;
        while (index < document.length && document[index] !== '"') {
          index += document[index] === "\\" ? 2 : 1;
        }
        index += 1;
      }
      // Left as a token that is neither a name nor a brace, so a default value
      // of `""` still reads as a value rather than as nothing at all.
      out += "_";
      continue;
    }

    // Numbers go the same way as strings. An inline `verifyOtp(code: 489213)`
    // or `charge(amount: 1999)` is user data exactly as a string literal is,
    // and blanking it also keeps `first: 10` and `first: 20` one shape. A
    // digit that continues a name (`field2`, `$var1`) is not a literal.
    const startsNumber =
      isDigit(char) || (char === "-" && isDigit(document[index + 1] ?? ""));
    if (startsNumber && !isNameChar(out[out.length - 1] ?? "")) {
      index += 1;
      while (index < document.length && isNumberChar(document, index)) {
        index += 1;
      }
      out += "_";
      continue;
    }

    out += char;
    index += 1;
  }

  return out;
}

function isDigit(char: string): boolean {
  return char >= "0" && char <= "9";
}

/** Digits, the fraction point, and an exponent with its sign: `-1.5e+3`. */
function isNumberChar(document: string, index: number): boolean {
  const char = document[index];
  if (isDigit(char) || char === "." || char === "e" || char === "E") {
    return true;
  }
  const previous = document[index - 1];
  return (
    (char === "+" || char === "-") && (previous === "e" || previous === "E")
  );
}

function skipBalanced(
  source: string,
  from: number,
  open: string,
  close: string,
): number {
  let depth = 0;
  let index = from;

  while (index < source.length) {
    const char = source[index];
    if (char === open) {
      depth += 1;
    } else if (char === close) {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
    }
    index += 1;
  }

  return source.length;
}

function isNameStart(char: string): boolean {
  return /[_A-Za-z]/.test(char);
}

function isNameChar(char: string): boolean {
  return /[_0-9A-Za-z]/.test(char);
}

function isIgnored(char: string): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r";
}
