import { OutgoingSpanRecorder } from "./outgoing-span.recorder.js";
import { patchMethod } from "./patch-method.util.js";

interface MongoConnectionModule {
  Connection?: { prototype?: object };
}

const MAX_STATEMENT_LENGTH = 2048;
const MAX_DEPTH = 10;
/** Pipeline stages and `$and`/`$or` branches kept before the rest are cut. */
const MAX_ARRAY_DOCUMENTS = 20;

/**
 * Commands the driver issues for itself: the handshake and authentication of
 * a connection it is opening, liveness checks, session and cursor cleanup.
 * They are not the application's work, but a pool that grows to serve a burst
 * opens its connections - and so shakes hands - inside the async context of
 * whichever request caused the burst, where they would appear as spans that
 * request never asked for.
 */
const DRIVER_HOUSEKEEPING = new Set([
  "hello",
  "ismaster",
  "isMaster",
  "saslStart",
  "saslContinue",
  "authenticate",
  "getnonce",
  "ping",
  "buildInfo",
  "endSessions",
  "killCursors",
]);

/**
 * Commands whose first value is the collection, or the namespace, they act
 * on: what the driver builds for a collection's own methods, and the
 * collection commands an application sends through `db.command()`. Only these
 * keep that value. Anywhere else it is data like any other - the user of
 * `createUser`, `dropUser` and `usersInfo`, the role of `createRole`, the free
 * text of `logApplicationMessage`. A command missing from the list loses its
 * collection from the span, and nothing else.
 */
const NAMES_A_COLLECTION = new Set([
  "find",
  "insert",
  "update",
  "delete",
  "aggregate",
  "count",
  "distinct",
  "findAndModify",
  "findandmodify",
  "mapReduce",
  "mapreduce",
  "create",
  "drop",
  "renameCollection",
  "collMod",
  "collStats",
  "validate",
  "compact",
  "reIndex",
  "convertToCapped",
  "cloneCollectionAsCapped",
  "createIndexes",
  "dropIndexes",
  "listIndexes",
  "createSearchIndexes",
  "updateSearchIndex",
  "dropSearchIndex",
]);

/**
 * A command with its values removed: field names and operators stay, since
 * they are the query's shape, and every primitive becomes `?`. The one value
 * kept is the collection a command names, which is to a command what the
 * table is to a SQL statement.
 *
 * Arrays come in two kinds and are told apart by what they hold. A list of
 * values keeps one element - `$in: [1, 2, 3]` and `$in: [4]` are the same
 * query. A list of documents is structure, not data: the stages of an
 * aggregation pipeline, the branches of an `$or`. Keeping one of those would
 * report a five-stage pipeline as its `$match` alone.
 */
export function describeMongoCommand(command: Record<string, unknown>): {
  operation: string;
  statement: string;
} {
  const [name] = Object.keys(command);
  const target =
    name !== undefined && NAMES_A_COLLECTION.has(name)
      ? command[name]
      : undefined;
  const operation =
    name === undefined
      ? "command"
      : typeof target === "string"
        ? `${name} ${target}`
        : name;

  // What is left of the statement to write. A command is the application's
  // data, and often its client's: a document that refers to one sub-document
  // from many fields - a GraphQL variable used many times over, a YAML alias -
  // is small to hold and has no end when copied out as a tree, and the
  // command is described before the driver's size limit can refuse it. Every
  // value is charged one character and every field its name, never more than
  // they take up once written, so by the time the budget is spent the walk is
  // past the cut below and the statement is what it would have been.
  let budget = MAX_STATEMENT_LENGTH;
  // Telling a list of values from a list of documents means looking at every
  // element, which the budget cannot charge for: a list of values is one `?`
  // however long it is. So each array is looked through once, and the fields
  // that refer to it again are answered from here.
  const documentsOf = new Map<unknown[], unknown[]>();

  const scrub = (value: unknown, depth: number): unknown => {
    budget -= 1;
    if (budget <= 0) {
      return "?";
    }
    if (value === null || typeof value !== "object") {
      return "?";
    }
    if (depth >= MAX_DEPTH) {
      return "?";
    }
    if (Array.isArray(value)) {
      let documents = documentsOf.get(value);
      if (documents === undefined) {
        documents = value.filter(
          (item) => item !== null && typeof item === "object",
        );
        documentsOf.set(value, documents);
      }
      if (documents.length === 0) {
        return value.length === 0 ? [] : ["?"];
      }
      return documents
        .slice(0, MAX_ARRAY_DOCUMENTS)
        .map((item) => scrub(item, depth + 1));
    }
    // ObjectId, Date, Binary, Long: BSON values, not sub-documents.
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      return "?";
    }
    return fields(Object.entries(value), (item) => scrub(item, depth + 1));
  };

  // Session, cluster time and read preference: driver bookkeeping.
  const shape = fields(
    Object.entries(command).filter(
      ([key]) => key !== "lsid" && !key.startsWith("$"),
    ),
    (value, key) =>
      key === name && typeof target === "string" ? target : scrub(value, 0),
  );
  let statement: string;
  try {
    statement = JSON.stringify(shape).slice(0, MAX_STATEMENT_LENGTH);
  } catch {
    statement = operation;
  }
  return { operation, statement };

  /**
   * The fields of a document, described one by one until the budget is spent.
   * Defined, not assigned: the names are the application's data, and
   * assigning one called `__proto__` or `constructor` reaches
   * `Object.prototype` instead of making a field - an accessor that throws
   * under `--disable-proto=throw`, a read-only property once it is frozen.
   */
  function fields(
    entries: Array<[string, unknown]>,
    describe: (value: unknown, key: string) => unknown,
  ): Record<string, unknown> {
    const described: Array<[string, unknown]> = [];
    for (const [key, value] of entries) {
      if (budget <= 0) {
        break;
      }
      budget -= key.length;
      described.push([key, describe(value, key)]);
    }
    return Object.fromEntries(described);
  }
}

/**
 * Command spans for the `mongodb` driver, and so for Mongoose and the Mongo
 * modes of TypeORM and MikroORM.
 *
 * A write the server rejects - a duplicate key, a failed validator - does
 * not fail here. The command itself succeeds and carries the rejection in its
 * reply as `writeErrors`; the driver raises it a layer up. Reading the reply
 * to find out would mean parsing the driver's lazily-decoded response, so the
 * command's span stays clean and the error lands where the driver throws it:
 * on the application method that made the call, one row above in the trace.
 *
 * Patched at the connection, where every operation - whichever collection
 * helper or cursor produced it - becomes one wire command. The driver's own
 * command monitoring would be the supported route, but it is switched on by a
 * `MongoClient` option, which is the application's to pass, not an agent's.
 */
export function patchMongodb(
  connectionModule: MongoConnectionModule,
  recorder: OutgoingSpanRecorder,
): boolean {
  return patchMethod(
    connectionModule.Connection?.prototype,
    "command",
    (original) =>
      function (this: unknown, ...args: any[]) {
        const command: unknown = args[1];
        if (!command || typeof command !== "object") {
          return original.apply(this, args);
        }
        const [commandName] = Object.keys(command);
        // Asked before the command is described: an untraced or sampled-out
        // call should not pay for a description nobody will read.
        if (
          commandName === undefined ||
          DRIVER_HOUSEKEEPING.has(commandName) ||
          !recorder.isRecording()
        ) {
          return original.apply(this, args);
        }
        const { operation, statement } = describeMongoCommand(
          command as Record<string, unknown>,
        );
        const span = recorder.open("mongodb", operation, {
          "db.system": "mongodb",
          "db.statement": statement,
        });
        if (!span) {
          return original.apply(this, args);
        }
        // Nothing in the arguments is touched. The last one looks like a
        // callback and is not: `command(ns, command, options, responseType)`
        // passes a response *class*, and wrapping it - as a first version of
        // this did, taking any trailing function for a legacy callback - makes
        // every operation throw inside the driver. A 4.x driver that really
        // does pass a callback returns no promise, and `endWhenSettled` then
        // closes the span on the spot: a span without its duration, which is
        // the right price for never standing between a driver and its own
        // arguments.
        try {
          return recorder.endWhenSettled(span, original.apply(this, args));
        } catch (error) {
          span.end(error);
          throw error;
        }
      },
  );
}
