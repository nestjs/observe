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
  /** The field is an array of `type`. */
  readonly array?: boolean;
  /** Nested contract, for object fields the API models rather than passes through. */
  readonly shape?: Shape;
  /** The nested contract is this shape itself - trace nodes nest arbitrarily deep. */
  readonly recursive?: boolean;
}

export type Shape = Readonly<Record<string, FieldSpec>>;

/** One span. Nests through `ch` to whatever depth the operation produced. */
const TRACE_NODE: Shape = {
  n: { type: "string" },
  o: { type: "string" },
  t: { type: "object" },
  d: { type: "number" },
  // Boolean is the "an error occurred but was handled, details not captured"
  // form - every failed non-root span, and a root span failing on a thrown
  // primitive, reports `e: true` rather than an error object. See
  // `TraceSpan.error`.
  e: { type: "object", alsoAccepts: ["boolean"] },
  c: { type: "string" },
  m: { type: "string" },
  s: { type: "string" },
  so: { type: "number" },
  ch: { type: "object", array: true, recursive: true },
};

const REQUEST_ATTRIBUTES: Shape = {
  m: { type: "string" },
  sc: { type: "number" },
  ou: { type: "string" },
};

/** No `st`: see the note at the top of this file. */
const REQUEST_SNAPSHOT: Shape = {
  ct: { type: "string" },
  ti: { type: "string", required: true },
  d: { type: "number" },
  p: { type: "string" },
  op: { type: "string" },
  u: { type: "string" },
  tg: { type: "object" },
  e: { type: "object" },
  rq: { type: "object" },
  a: { type: "object", shape: REQUEST_ATTRIBUTES },
  t: { type: "object", array: true, shape: TRACE_NODE },
};

/** No `st` here either, for the same reason. */
const JOB_SNAPSHOT: Shape = {
  i: { type: "string", required: true },
  ti: { type: "string" },
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
  t: { type: "object", array: true, shape: TRACE_NODE },
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
          m: { type: "number" },
          j: { type: "number" },
          i: { type: "number" },
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

const CUSTOM_METRIC: Shape = {
  n: { type: "string", required: true },
  t: { type: "string" },
  v: { type: "number" },
  tg: { type: "object" },
  d: { type: "string" },
  l: { type: "object" },
  lu: { type: "number" },
  k: { type: "string" },
  iv: { type: "number" },
  q50: { type: "number" },
  q95: { type: "number" },
  q99: { type: "number" },
  ct: { type: "number" },
  sm: { type: "number" },
  mx: { type: "number" },
};

const LOG_ENTRY: Shape = {
  timestamp: { type: "number", required: true },
  text: { type: "string", required: true },
  traceId: { type: "string" },
  spanId: { type: "string" },
  level: { type: "string" },
  context: { type: "string" },
  attributes: { type: "object" },
};

/** The batch body the agent POSTs to the collector. */
export const TELEMETRY_BATCH: Shape = {
  serviceId: { type: "string", required: true },
  serviceVersion: { type: "string" },
  forwardLogs: { type: "boolean" },
  snapshots: { type: "object", array: true, shape: REQUEST_SNAPSHOT },
  jobs: { type: "object", array: true, shape: JOB_SNAPSHOT },
  runtime: { type: "object", shape: RUNTIME_METRICS },
  custom: { type: "object", array: true, shape: CUSTOM_METRIC },
  logs: { type: "object", array: true, shape: LOG_ENTRY },
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
  }
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
 * the batch.
 *
 * Numbers must be finite: `NaN` and `Infinity` survive `typeof` but serialize
 * to `null` in JSON, which arrives at the API as a present-but-null field and
 * fails validation there. They are judged here as what they will be on the
 * wire, not as what they are in memory.
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
  // Local copy of the module-level helper, for the self-containment above.
  const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

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
        if (spec.required) {
          problems.push(`${fieldPath}: required`);
          usable = false;
        } else if (key in value) {
          // Explicit nulls fail the API's type checks even on optional
          // fields; absent keys do not.
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
