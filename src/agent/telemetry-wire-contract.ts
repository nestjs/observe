/**
 * The shape the ingestion API accepts, declared here rather than imported from
 * the collector's DTOs.
 *
 * The encoders and the API agree on nothing but single-letter key names, so
 * something has to fail when they drift. That used to be the API's
 * `InsertTelemetryDataDto`, reached across the repo boundary - which meant this
 * package could not be built, tested or published on its own. The contract is
 * restated here instead: it is the SDK's copy of the agreement, and the thing
 * that has to be updated in lockstep when the API changes.
 *
 * Deliberately *not* generated from the encoders' key maps. A contract derived
 * from the code it checks asserts only that the code equals itself. Every key
 * below is written out by hand so that changing a key map breaks a test and
 * forces the API change to be made consciously.
 *
 * The clearest example is `st`: both snapshot encoders map `startTimestamp` to
 * it, and it is absent here on purpose. The API does not declare that field, it
 * validates with `forbidNonWhitelisted`, and what keeps it off the wire is
 * `OperationTraceRegistry.endTrace` deleting it before the encoder ever sees
 * the snapshot. A payload that still carries `st` is rejected with a 400, so
 * `validateTelemetryPayload(..., { forbidUnknown: true })` rejects it too.
 *
 * Lives under `src/agent` rather than `src/testing` because the contract is no
 * longer only a test assertion: when the collector answers 400, the detached
 * worker applies it to the rejected batch - stripping what the API refuses and
 * dropping individual unsalvageable entries - then re-sends once, so one bad
 * entry cannot cost the batch. Healthy batches are never touched.
 */

type FieldType = "string" | "number" | "boolean" | "object";

export interface FieldSpec {
  /** Primitive type, or the type of each element for an array field. */
  readonly type: FieldType;
  /**
   * Additional acceptable types beyond `type`, for the few fields the API
   * models as a union. A value matching one of these is passed through as-is,
   * with no nested shape applied.
   */
  readonly alsoAccepts?: readonly FieldType[];
  /** The field must be present and non-null. */
  readonly required?: boolean;
  /**
   * For a required field whose absence has a meaning: what the sanitizer
   * sends in its place, instead of dropping the entry over it. Plain JSON, as
   * it travels to the worker with the shapes.
   */
  readonly fallback?: unknown;
  /** The field is an array of `type`. */
  readonly array?: boolean;
  /** Nested contract, for object fields the API models rather than passes through. */
  readonly shape?: Shape;
  /** The nested contract is this shape itself - trace nodes nest arbitrarily deep. */
  readonly recursive?: boolean;
  /**
   * Longest string the API accepts (`@MaxLength`), counted the way it counts:
   * a surrogate pair or a variation selector is not a character of its own.
   * For an array of strings, the limit on each element.
   */
  readonly maxLength?: number;
  /** The only values the API accepts (`@IsIn`, `@IsEnum`). */
  readonly oneOf?: readonly (string | number)[];
  /** Most elements the API accepts in an array field (`@ArrayMaxSize`). */
  readonly maxItems?: number;
}

export type Shape = Readonly<Record<string, FieldSpec>>;

/**
 * Most entries the API accepts in one section of a batch. It refuses a batch
 * with more whole, so every producer has to stay under it.
 */
export const MAX_BATCH_ITEMS = 5000;

/** The levels a forwarded log line may carry - Nest's own. */
const LOG_LEVELS = ["fatal", "error", "warn", "log", "debug", "verbose"];

/**
 * One span. Nests through `ch` to whatever depth the operation produced.
 *
 * The API checks spans by hand rather than through a DTO, and requires `o`,
 * `c` and `m` of every one - so a span missing any of them, or carrying one
 * the API refuses, is dropped from its tree on repair rather than stripped of
 * the field and refused again.
 */
const TRACE_NODE: Shape = {
  n: { type: "string", maxLength: 255 },
  o: { type: "string", required: true, oneOf: ["manual", "auto"] },
  t: { type: "object" },
  d: { type: "number" },
  // Boolean is the "an error occurred but was handled, details not captured"
  // form - every failed non-root span, and a root span failing on a thrown
  // primitive, reports `e: true` rather than an error object. See
  // `TraceSpan.error`.
  e: { type: "object", alsoAccepts: ["boolean"] },
  c: { type: "string", required: true, maxLength: 255 },
  m: { type: "string", required: true, maxLength: 255 },
  s: { type: "string" },
  so: { type: "number" },
  ch: { type: "object", array: true, recursive: true },
};

/**
 * The API takes the attributes as one object and checks none of its keys,
 * so these are not refused there. They are declared all the same: a repair
 * removes what is undeclared, and `dop` is what marks a request as renamed.
 */
const REQUEST_ATTRIBUTES: Shape = {
  m: { type: "string" },
  sc: { type: "number" },
  ou: { type: "string" },
  dop: { type: "string" },
};

/**
 * An operation's spans. Required - the API refuses an operation without the
 * array, and the batch with it - but empty when there are none, including when
 * the agent withheld them from a degraded account. Agents 0.2.1 to 0.3.9
 * deleted the key instead, and every degraded batch carrying an ordinary
 * request or job was refused whole.
 */
const TRACES: FieldSpec = {
  type: "object",
  array: true,
  required: true,
  fallback: [],
  shape: TRACE_NODE,
};

/** No `st`: see the note at the top of this file. */
const REQUEST_SNAPSHOT: Shape = {
  ct: { type: "string" },
  ti: { type: "string", required: true, maxLength: 255 },
  d: { type: "number" },
  p: { type: "string" },
  // Required as the API requires it. The application can set it now
  // (`TracerService.setOperationId`), so an unusable one can reach a batch, and
  // a repair that only stripped it would re-send an entry the API refuses
  // again - costing the whole batch rather than the one operation.
  op: { type: "string", required: true },
  u: { type: "string" },
  tg: { type: "object" },
  e: { type: "object" },
  rq: { type: "object" },
  a: { type: "object", shape: REQUEST_ATTRIBUTES },
  t: TRACES,
};

/** No `st` here either, for the same reason. */
const JOB_SNAPSHOT: Shape = {
  i: { type: "string", required: true },
  ti: { type: "string", required: true, maxLength: 255 },
  n: { type: "string" },
  q: { type: "string" },
  s: { type: "string" },
  c: { type: "string" },
  d: { type: "number" },
  ea: { type: "string" },
  wd: { type: "number" },
  am: { type: "number" },
  ma: { type: "number" },
  tg: { type: "object" },
  e: { type: "object" },
  t: TRACES,
};

/**
 * One kind of collection in a runtime window. The encoder shortens the kind's
 * key (`m`, `j`, `i`) but not these.
 */
const GC_COLLECTIONS: Shape = {
  count: { type: "number" },
  duration: { type: "number" },
};

const RUNTIME_METRICS: Shape = {
  c: {
    type: "object",
    shape: {
      u: { type: "number" },
      s: { type: "number" },
      p: { type: "number" },
    },
  },
  m: {
    type: "object",
    shape: {
      r: { type: "number" },
      ht: { type: "number" },
      hu: { type: "number" },
      e: { type: "number" },
      ab: { type: "number" },
      p: { type: "number" },
    },
  },
  g: {
    type: "object",
    shape: {
      c: { type: "number" },
      td: { type: "number" },
      b: {
        type: "object",
        shape: {
          m: { type: "object", shape: GC_COLLECTIONS },
          j: { type: "object", shape: GC_COLLECTIONS },
          i: { type: "object", shape: GC_COLLECTIONS },
        },
      },
    },
  },
  e: {
    type: "object",
    shape: {
      l: { type: "number" },
      u: { type: "number" },
    },
  },
};

/**
 * Every reading - `v`, `iv` and a summary's six distribution fields - is a map
 * from label to number, keyed by whatever labels the application chose, so the
 * contract declares the map rather than its entries. `l` is the label names.
 *
 * The collector also bounds each map - finite numbers, at most 1000 keys of at
 * most 255 characters - and refuses the whole batch over one that is not. The
 * metric classes keep within those bounds at the source, where a bad reading
 * can still be dropped on its own.
 */
const CUSTOM_METRIC: Shape = {
  n: { type: "string", required: true, maxLength: 100 },
  t: { type: "string", required: true, oneOf: ["counter", "gauge", "summary"] },
  v: { type: "object" },
  tg: { type: "object" },
  d: { type: "string", maxLength: 255 },
  l: { type: "string", array: true, maxLength: 255, maxItems: 1000 },
  lu: { type: "number" },
  k: { type: "string", oneOf: ["additive", "ratio", "peak"] },
  iv: { type: "object" },
  q50: { type: "object" },
  q95: { type: "object" },
  q99: { type: "object" },
  ct: { type: "object" },
  sm: { type: "object" },
  mx: { type: "object" },
};

const LOG_ENTRY: Shape = {
  timestamp: { type: "number", required: true },
  text: { type: "string", required: true },
  traceId: { type: "string", maxLength: 255 },
  spanId: { type: "string", maxLength: 255 },
  level: { type: "string", oneOf: LOG_LEVELS },
  context: { type: "string", maxLength: 255 },
  attributes: { type: "object" },
};

/** One `@Objective(...)` as a handler declares it. */
const DECLARED_OBJECTIVE: Shape = {
  availability: { type: "number" },
  latency: {
    type: "object",
    shape: {
      underMs: { type: "number", required: true },
      target: { type: "number", required: true },
    },
  },
  windowDays: { type: "number", oneOf: [7, 14, 28, 30] },
  name: { type: "string", maxLength: 120 },
};

/** A handler's objectives, with the route it was seen to serve. */
const OBJECTIVE_DECLARATION: Shape = {
  handler: { type: "string", required: true, maxLength: 255 },
  operationId: { type: "string", required: true, maxLength: 255 },
  method: { type: "string", maxLength: 10 },
  objectives: {
    type: "object",
    array: true,
    required: true,
    maxItems: 10,
    shape: DECLARED_OBJECTIVE,
  },
};

/**
 * The batch body the agent POSTs to the collector.
 *
 * Only the sections' entries are repaired on a 400 - see `SECTION_SHAPES`. The
 * limits on the batch itself (the service id, how many entries a section
 * holds) are kept where the batch is built, and are declared here so a test
 * that sends one over them fails.
 */
export const TELEMETRY_BATCH: Shape = {
  serviceId: { type: "string", required: true, maxLength: 100 },
  serviceVersion: { type: "string", maxLength: 50 },
  truncatedSpans: { type: "number" },
  forwardLogs: { type: "boolean" },
  snapshots: {
    type: "object",
    array: true,
    maxItems: MAX_BATCH_ITEMS,
    shape: REQUEST_SNAPSHOT,
  },
  jobs: {
    type: "object",
    array: true,
    maxItems: MAX_BATCH_ITEMS,
    shape: JOB_SNAPSHOT,
  },
  runtime: { type: "object", shape: RUNTIME_METRICS },
  custom: {
    type: "object",
    array: true,
    maxItems: MAX_BATCH_ITEMS,
    shape: CUSTOM_METRIC,
  },
  logs: {
    type: "object",
    array: true,
    maxItems: MAX_BATCH_ITEMS,
    shape: LOG_ENTRY,
  },
  objectives: {
    type: "object",
    array: true,
    maxItems: 100,
    shape: OBJECTIVE_DECLARATION,
  },
};

/**
 * The sections of a batch whose entries are individually expendable. Maps each
 * to the shape one entry must satisfy, so the flush path can judge entries one
 * at a time instead of the collector judging the batch as a whole.
 */
export const SECTION_SHAPES = {
  snapshots: REQUEST_SNAPSHOT,
  jobs: JOB_SNAPSHOT,
  custom: CUSTOM_METRIC,
  logs: LOG_ENTRY,
  runtime: RUNTIME_METRICS,
} as const;

export type TelemetrySection = keyof typeof SECTION_SHAPES;

export interface ValidateOptions {
  /**
   * Reject keys the contract does not declare, mirroring the API's
   * `forbidNonWhitelisted` validation. Off by default, matching a plain
   * `validate()` call, which ignores undeclared properties.
   */
  readonly forbidUnknown?: boolean;
}

/**
 * Checks a batch body against the contract and returns one message per problem,
 * empty when the payload is acceptable. Paths are dotted, with array indices, so
 * a failure names the exact field: `snapshots[0].a.sc`.
 */
export function validateTelemetryPayload(
  payload: unknown,
  options: ValidateOptions = {},
): string[] {
  const errors: string[] = [];
  checkShape(payload, TELEMETRY_BATCH, "", options, errors);
  return errors;
}

function checkShape(
  value: unknown,
  shape: Shape,
  path: string,
  options: ValidateOptions,
  errors: string[],
): void {
  if (!isPlainObject(value)) {
    errors.push(`${path || "payload"}: expected an object`);
    return;
  }

  for (const [key, spec] of Object.entries(shape)) {
    const present = value[key] !== undefined && value[key] !== null;
    if (!present) {
      if (spec.required) {
        errors.push(`${join(path, key)}: required`);
      }
      continue;
    }
    checkField(value[key], spec, shape, join(path, key), options, errors);
  }

  if (options.forbidUnknown) {
    for (const key of Object.keys(value)) {
      if (!(key in shape)) {
        errors.push(`${join(path, key)}: not declared by the contract`);
      }
    }
  }
}

function checkField(
  value: unknown,
  spec: FieldSpec,
  parent: Shape,
  path: string,
  options: ValidateOptions,
  errors: string[],
): void {
  if (spec.array) {
    if (!Array.isArray(value)) {
      errors.push(`${path}: expected an array`);
      return;
    }
    if (spec.maxItems !== undefined && value.length > spec.maxItems) {
      errors.push(`${path}: more than ${spec.maxItems} items`);
    }
    value.forEach((item, index) => {
      checkField(
        item,
        { ...spec, array: false },
        parent,
        `${path}[${index}]`,
        options,
        errors,
      );
    });
    return;
  }

  if (spec.alsoAccepts?.includes(typeof value as FieldType)) {
    return;
  }

  // `recursive` means "the shape this field lives in", which is how a span's
  // children are described without the contract referring to itself before it
  // is defined.
  const nested = spec.recursive ? parent : spec.shape;
  if (nested) {
    checkShape(value, nested, path, options, errors);
    return;
  }

  if (spec.type === "object") {
    if (!isPlainObject(value)) {
      errors.push(`${path}: expected an object`);
    }
    return;
  }
  if (typeof value !== spec.type) {
    errors.push(`${path}: expected a ${spec.type}, got ${typeof value}`);
    return;
  }
  if (spec.oneOf && !spec.oneOf.includes(value as string | number)) {
    errors.push(`${path}: not one of ${spec.oneOf.join(", ")}`);
  }
  if (
    spec.maxLength !== undefined &&
    typeof value === "string" &&
    exceedsMaxLength(value, spec.maxLength)
  ) {
    errors.push(`${path}: longer than ${spec.maxLength} characters`);
  }
}

/**
 * Whether a string is longer than the API's `@MaxLength` allows. It counts the
 * way validator.js's `isLength` does - the second half of a surrogate pair and
 * a variation selector are not characters - so the exact count is taken only
 * once `.length`, which can only overcount, says the string might be over.
 */
function exceedsMaxLength(value: string, maxLength: number): boolean {
  if (value.length <= maxLength) {
    return false;
  }
  const pairs = value.match(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g)?.length ?? 0;
  const selectors = value.match(/[\uFE0E\uFE0F]/g)?.length ?? 0;
  return value.length - pairs - selectors > maxLength;
}

export interface SanitizeEntryResult {
  /** Whether the entry is still sendable once stripped. */
  ok: boolean;
  problems: string[];
}

export interface SanitizeBatchResult {
  /** Whether anything was stripped or dropped - false means the batch was already in contract. */
  changed: boolean;
  /** Entries removed outright because a required field was beyond repair. */
  dropped: number;
  problems: string[];
}

export interface TelemetrySanitizer {
  sanitizeEntry(section: TelemetrySection, entry: unknown): SanitizeEntryResult;
  sanitizeBatch(payload: Record<string, unknown>): SanitizeBatchResult;
}

/**
 * Builds the sanitizer that brings a rejected batch into contract.
 *
 * Two halves, mirroring the two halves of the API's validation. Keys the
 * contract does not declare, and *optional* fields carrying the wrong type,
 * are removed in place - the data they sat next to is still good, and the API
 * would have rejected the whole batch over them (`forbidNonWhitelisted`).
 * A *required* field that is missing or unusable cannot be repaired by
 * removal, so the entry is dropped alone rather than the collector dropping
 * the batch - unless the contract names a fallback for a missing one, as it
 * does for an operation's spans: an operation without its trace array is sent
 * with an empty one, which is what the absence meant.
 *
 * Numbers must be finite: `NaN` and `Infinity` survive `typeof` but serialize
 * to `null` in JSON, which arrives at the API as a present-but-null field and
 * fails validation there. They are judged here as what they will be on the
 * wire, not as what they are in memory.
 *
 * Limits are judged like types: an optional field longer than the API takes,
 * or holding a value it does not accept, is removed, and a required one costs
 * its entry. A string is removed rather than cut on purpose. Everything that
 * can legitimately run long is already cut where it is produced, with a hash
 * that keeps two cut values apart (`fitToLength`), so a value still over its
 * limit when the API refuses the batch is a bug upstream - the worker's report
 * names it, where a cut would hide it behind a plausible value. And most
 * bounded fields are identifiers, trace and span ids and metric names, which a
 * cut turns into the name of something else. An array over its size is the
 * exception: it keeps its head, since each element is a value on its own.
 *
 * A factory rather than module-level functions, and deliberately
 * self-contained - it closes over nothing but its own parameter. The detached
 * worker runs as a stringified function with no module scope, so this
 * function's *source* is inlined into the worker script
 * (`createTelemetrySanitizer.toString()`) and called with the shapes passed
 * through `workerData`. Referencing anything from this module's scope would
 * compile, then throw at runtime inside the worker.
 *
 * This is also why sanitization happens in the worker at all: it runs only
 * when the collector has actually answered 400, on the worker thread, so a
 * healthy application never pays for it - not per flush, and not on the main
 * thread.
 */
export function createTelemetrySanitizer(
  shapes: Record<TelemetrySection, Shape>,
): TelemetrySanitizer {
  // Local copies of the module-level helpers, for the self-containment above
  // - moving them out, as the linter asks, is exactly what would break it.
  // oxlint-disable-next-line unicorn/consistent-function-scoping
  const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  // oxlint-disable-next-line unicorn/consistent-function-scoping
  const isTooLong = (value: string, maxLength: number): boolean => {
    if (value.length <= maxLength) {
      return false;
    }
    const pairs = value.match(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g)?.length ?? 0;
    const selectors = value.match(/[\uFE0E\uFE0F]/g)?.length ?? 0;
    return value.length - pairs - selectors > maxLength;
  };

  /** Returns whether the value is still usable once stripped. */
  const sanitizeShape = (
    value: unknown,
    shape: Shape,
    path: string,
    problems: string[],
  ): boolean => {
    if (!isPlainRecord(value)) {
      problems.push(`${path}: expected an object`);
      return false;
    }

    let usable = true;
    for (const key of Object.keys(value)) {
      if (!(key in shape)) {
        problems.push(`${path}.${key}: not declared by the contract, removed`);
        delete value[key];
      }
    }

    for (const [key, spec] of Object.entries(shape)) {
      const fieldPath = `${path}.${key}`;
      const present = value[key] !== undefined && value[key] !== null;
      if (!present) {
        if (spec.required && spec.fallback !== undefined) {
          problems.push(
            `${fieldPath}: required, sent as ${JSON.stringify(spec.fallback)}`,
          );
          value[key] = structuredClone(spec.fallback);
        } else if (spec.required) {
          problems.push(`${fieldPath}: required`);
          usable = false;
        } else if (key in value) {
          // Explicit nulls fail the API's type checks even on optional
          // fields; absent keys do not. Reported like every other removal:
          // a repair that is not is a batch dropped rather than re-sent -
          // and a non-finite number reaches here as the `null` that
          // `JSON.stringify` made of it. `undefined` never reached the wire.
          if (value[key] === null) {
            problems.push(`${fieldPath}: null, removed`);
          }
          delete value[key];
        }
        continue;
      }

      if (!sanitizeField(value[key], spec, shape, fieldPath, problems)) {
        if (spec.required) {
          usable = false;
        } else {
          delete value[key];
        }
      }
    }
    return usable;
  };

  /** Returns whether the field value is acceptable (possibly after stripping). */
  const sanitizeField = (
    value: unknown,
    spec: FieldSpec,
    parent: Shape,
    path: string,
    problems: string[],
  ): boolean => {
    if (spec.array) {
      if (!Array.isArray(value)) {
        problems.push(`${path}: expected an array, removed`);
        return false;
      }
      // Unsalvageable elements are removed one by one - backwards, so the
      // removal of one does not shift the index of the next.
      for (let index = value.length - 1; index >= 0; index--) {
        const elementSpec = { ...spec, array: false };
        if (
          !sanitizeField(
            value[index],
            elementSpec,
            parent,
            `${path}[${index}]`,
            problems,
          )
        ) {
          value.splice(index, 1);
        }
      }
      if (spec.maxItems !== undefined && value.length > spec.maxItems) {
        problems.push(
          `${path}: more than ${spec.maxItems} items, ${value.length - spec.maxItems} removed`,
        );
        value.length = spec.maxItems;
      }
      return true;
    }

    if (spec.alsoAccepts?.includes(typeof value as FieldType)) {
      return true;
    }

    const nested = spec.recursive ? parent : spec.shape;
    if (nested) {
      return sanitizeShape(value, nested, path, problems);
    }

    if (spec.type === "object") {
      if (!isPlainRecord(value)) {
        problems.push(`${path}: expected an object, removed`);
        return false;
      }
      return true;
    }
    if (typeof value !== spec.type) {
      problems.push(`${path}: expected a ${spec.type}, got ${typeof value}`);
      return false;
    }
    if (spec.type === "number" && !Number.isFinite(value)) {
      // Serializes to null, which the API reads as a present, invalid field.
      problems.push(`${path}: non-finite number`);
      return false;
    }
    if (spec.oneOf && !spec.oneOf.includes(value as string | number)) {
      problems.push(`${path}: not one of ${spec.oneOf.join(", ")}`);
      return false;
    }
    if (
      spec.maxLength !== undefined &&
      typeof value === "string" &&
      isTooLong(value, spec.maxLength)
    ) {
      problems.push(`${path}: longer than ${spec.maxLength} characters`);
      return false;
    }
    return true;
  };

  const sanitizeEntry = (
    section: TelemetrySection,
    entry: unknown,
  ): SanitizeEntryResult => {
    const problems: string[] = [];
    const ok = sanitizeShape(entry, shapes[section], section, problems);
    return { ok, problems };
  };

  /**
   * Repairs a whole batch in place, entry by entry. Every reported problem
   * corresponds to a mutation - a stripped field or a dropped entry - so
   * `changed` doubles as "worth re-sending".
   */
  const sanitizeBatch = (
    payload: Record<string, unknown>,
  ): SanitizeBatchResult => {
    const problems: string[] = [];
    let dropped = 0;

    const arraySections: TelemetrySection[] = [
      "snapshots",
      "jobs",
      "custom",
      "logs",
    ];
    for (const section of arraySections) {
      const entries = payload[section];
      if (!Array.isArray(entries)) {
        continue;
      }
      payload[section] = entries.filter((entry) => {
        const result = sanitizeEntry(section, entry);
        problems.push(...result.problems);
        if (!result.ok) {
          dropped += 1;
        }
        return result.ok;
      });
    }

    if (payload.runtime !== undefined && payload.runtime !== null) {
      const result = sanitizeEntry("runtime", payload.runtime);
      problems.push(...result.problems);
      if (!result.ok) {
        dropped += 1;
        delete payload.runtime;
      }
    }

    return { changed: problems.length > 0, dropped, problems };
  };

  return { sanitizeEntry, sanitizeBatch };
}

/**
 * The default sanitizer over this module's own shapes - what tests exercise,
 * and the same instance the worker builds for itself from the factory's
 * source.
 */
const defaultSanitizer = createTelemetrySanitizer(SECTION_SHAPES);

export function sanitizeTelemetryEntry(
  section: TelemetrySection,
  entry: unknown,
): SanitizeEntryResult {
  return defaultSanitizer.sanitizeEntry(section, entry);
}

export function sanitizeTelemetryBatch(
  payload: Record<string, unknown>,
): SanitizeBatchResult {
  return defaultSanitizer.sanitizeBatch(payload);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function join(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}
