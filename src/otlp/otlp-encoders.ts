import type { OtlpAttributeValue } from "./otlp-settings.util.js";
import type { OtlpAttribute, OtlpEvent, OtlpSpan } from "./otlp-span.mapper.js";

/** What every exported span names as the code that produced it. */
export interface OtlpScope {
  name: string;
  version: string;
}

/**
 * One `ExportTraceServiceRequest` - a resource, this agent's scope, and the
 * spans - in OTLP's JSON encoding.
 *
 * Not quite the standard protobuf-to-JSON mapping, as the OTLP spec says:
 * trace and span ids are hex rather than base64, and enums are numbers. The
 * 64-bit fields are decimal strings, as the mapping has them - a JSON number
 * cannot hold a nanosecond timestamp exactly.
 */
export function encodeOtlpJson(
  resource: OtlpAttribute[],
  scope: OtlpScope,
  spans: OtlpSpan[],
): string {
  return JSON.stringify({
    resourceSpans: [
      {
        resource: { attributes: resource.map(jsonKeyValue) },
        scopeSpans: [
          {
            scope: { name: scope.name, version: scope.version },
            spans: spans.map(jsonSpan),
          },
        ],
      },
    ],
  });
}

function jsonSpan(span: OtlpSpan) {
  return {
    traceId: span.traceId,
    spanId: span.spanId,
    ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
    ...(span.traceState ? { traceState: span.traceState } : {}),
    name: span.name,
    kind: span.kind,
    startTimeUnixNano: span.startTimeUnixNano.toString(),
    endTimeUnixNano: span.endTimeUnixNano.toString(),
    attributes: span.attributes.map(jsonKeyValue),
    ...(span.droppedAttributesCount > 0
      ? { droppedAttributesCount: span.droppedAttributesCount }
      : {}),
    ...(span.events.length > 0 ? { events: span.events.map(jsonEvent) } : {}),
    ...(span.status ? { status: span.status } : {}),
    flags: span.flags,
  };
}

function jsonEvent(event: OtlpEvent) {
  return {
    timeUnixNano: event.timeUnixNano.toString(),
    name: event.name,
    attributes: event.attributes.map(jsonKeyValue),
  };
}

function jsonKeyValue({ key, value }: OtlpAttribute) {
  return { key, value: jsonAnyValue(value) };
}

function jsonAnyValue(value: OtlpAttributeValue) {
  if (typeof value === "string") {
    return { stringValue: value };
  }
  if (typeof value === "boolean") {
    return { boolValue: value };
  }
  return Number.isSafeInteger(value)
    ? { intValue: String(value) }
    : { doubleValue: value };
}

// --- protobuf ---------------------------------------------------------------

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LENGTH_DELIMITED = 2;
const WIRE_FIXED32 = 5;

/**
 * Room reserved for a sub-message's length before the sub-message is
 * written: the most a varint of a 32-bit length takes. Whatever is not
 * needed is closed up once the length is known - see `endMessage`.
 */
const LENGTH_PREFIX_RESERVE = 5;

/**
 * Just enough of a protobuf writer for one message type, written out by
 * hand so the package gains no dependency for it.
 *
 * Everything goes into one growing buffer. A sub-message is written after a
 * reserved length prefix and the prefix filled in once its length is known,
 * moving the bytes back over whatever part of the reservation the varint did
 * not use - one copy per nesting level rather than a buffer per field, which
 * matters for a batch of a thousand spans encoded on the application's own
 * thread.
 */
class ProtoWriter {
  private buffer = Buffer.allocUnsafe(16 * 1024);
  private position = 0;
  private readonly openMessages: number[] = [];

  finish(): Buffer {
    return this.buffer.subarray(0, this.position);
  }

  /** A field's key: its number and how its value is laid out. */
  key(field: number, wireType: number): this {
    return this.varint(field * 8 + wireType);
  }

  /** A non-negative integer up to 2^53, as a varint. */
  varint(value: number): this {
    this.reserve(10);
    while (value > 0x7f) {
      this.buffer[this.position++] = value % 0x80 | 0x80;
      value = Math.floor(value / 0x80);
    }
    this.buffer[this.position++] = value;
    return this;
  }

  /** A 64-bit two's complement integer, as a varint - ten bytes if negative. */
  int64(value: number): this {
    if (value >= 0) {
      return this.varint(value);
    }
    let remaining = BigInt.asUintN(64, BigInt(value));
    this.reserve(10);
    while (remaining > 0x7fn) {
      this.buffer[this.position++] = Number(remaining & 0x7fn) | 0x80;
      remaining >>= 7n;
    }
    this.buffer[this.position++] = Number(remaining);
    return this;
  }

  fixed64(value: bigint): this {
    this.reserve(8);
    this.buffer.writeBigUInt64LE(BigInt.asUintN(64, value), this.position);
    this.position += 8;
    return this;
  }

  fixed32(value: number): this {
    this.reserve(4);
    this.buffer.writeUInt32LE(value >>> 0, this.position);
    this.position += 4;
    return this;
  }

  double(value: number): this {
    this.reserve(8);
    this.buffer.writeDoubleLE(value, this.position);
    this.position += 8;
    return this;
  }

  string(value: string): this {
    const length = Buffer.byteLength(value, "utf8");
    this.varint(length);
    this.reserve(length);
    this.buffer.write(value, this.position, length, "utf8");
    this.position += length;
    return this;
  }

  /** Bytes given as hex - the only bytes this message carries are ids. */
  hexBytes(hex: string): this {
    const length = hex.length / 2;
    this.varint(length);
    this.reserve(length);
    this.buffer.write(hex, this.position, length, "hex");
    this.position += length;
    return this;
  }

  beginMessage(field: number): this {
    this.key(field, WIRE_LENGTH_DELIMITED);
    this.reserve(LENGTH_PREFIX_RESERVE);
    this.openMessages.push(this.position);
    this.position += LENGTH_PREFIX_RESERVE;
    return this;
  }

  endMessage(): this {
    const prefixAt = this.openMessages.pop();
    if (prefixAt === undefined) {
      throw new Error("endMessage without beginMessage");
    }
    const contentStart = prefixAt + LENGTH_PREFIX_RESERVE;
    const length = this.position - contentStart;
    let at = prefixAt;
    let remaining = length;
    while (remaining > 0x7f) {
      this.buffer[at++] = remaining % 0x80 | 0x80;
      remaining = Math.floor(remaining / 0x80);
    }
    this.buffer[at++] = remaining;
    if (at < contentStart) {
      this.buffer.copyWithin(at, contentStart, this.position);
      this.position -= contentStart - at;
    }
    return this;
  }

  private reserve(bytes: number): void {
    if (this.position + bytes <= this.buffer.length) {
      return;
    }
    let size = this.buffer.length * 2;
    while (size < this.position + bytes) {
      size *= 2;
    }
    const grown = Buffer.allocUnsafe(size);
    this.buffer.copy(grown, 0, 0, this.position);
    this.buffer = grown;
  }
}

/**
 * One `ExportTraceServiceRequest` in OTLP's protobuf encoding, field numbers
 * as `opentelemetry/proto/collector/trace/v1/trace_service.proto` and the
 * messages it uses define them.
 *
 * Fields holding their default value are left out, as a protobuf encoder
 * leaves them out - except inside `AnyValue`, a `oneof`, where a zero, a
 * `false` or an empty string is the value and has to be written.
 */
export function encodeOtlpProtobuf(
  resource: OtlpAttribute[],
  scope: OtlpScope,
  spans: OtlpSpan[],
): Buffer {
  const writer = new ProtoWriter();
  // ExportTraceServiceRequest.resource_spans
  writer.beginMessage(1);
  {
    // ResourceSpans.resource
    writer.beginMessage(1);
    writeKeyValues(writer, 1, resource);
    writer.endMessage();
    // ResourceSpans.scope_spans
    writer.beginMessage(2);
    {
      // ScopeSpans.scope
      writer.beginMessage(1);
      writer.key(1, WIRE_LENGTH_DELIMITED).string(scope.name);
      writer.key(2, WIRE_LENGTH_DELIMITED).string(scope.version);
      writer.endMessage();
      // ScopeSpans.spans
      for (const span of spans) {
        writer.beginMessage(2);
        writeSpan(writer, span);
        writer.endMessage();
      }
    }
    writer.endMessage();
  }
  writer.endMessage();
  return writer.finish();
}

function writeSpan(writer: ProtoWriter, span: OtlpSpan): void {
  writer.key(1, WIRE_LENGTH_DELIMITED).hexBytes(span.traceId);
  writer.key(2, WIRE_LENGTH_DELIMITED).hexBytes(span.spanId);
  if (span.traceState) {
    writer.key(3, WIRE_LENGTH_DELIMITED).string(span.traceState);
  }
  if (span.parentSpanId) {
    writer.key(4, WIRE_LENGTH_DELIMITED).hexBytes(span.parentSpanId);
  }
  if (span.name) {
    writer.key(5, WIRE_LENGTH_DELIMITED).string(span.name);
  }
  writer.key(6, WIRE_VARINT).varint(span.kind);
  writer.key(7, WIRE_FIXED64).fixed64(span.startTimeUnixNano);
  writer.key(8, WIRE_FIXED64).fixed64(span.endTimeUnixNano);
  writeKeyValues(writer, 9, span.attributes);
  if (span.droppedAttributesCount > 0) {
    writer.key(10, WIRE_VARINT).varint(span.droppedAttributesCount);
  }
  for (const event of span.events) {
    writer.beginMessage(11);
    writer.key(1, WIRE_FIXED64).fixed64(event.timeUnixNano);
    writer.key(2, WIRE_LENGTH_DELIMITED).string(event.name);
    writeKeyValues(writer, 3, event.attributes);
    writer.endMessage();
  }
  if (span.status) {
    // Status.message is field 2 and Status.code field 3: field 1 is reserved.
    writer.beginMessage(15);
    if (span.status.message) {
      writer.key(2, WIRE_LENGTH_DELIMITED).string(span.status.message);
    }
    writer.key(3, WIRE_VARINT).varint(span.status.code);
    writer.endMessage();
  }
  if (span.flags) {
    writer.key(16, WIRE_FIXED32).fixed32(span.flags);
  }
}

function writeKeyValues(
  writer: ProtoWriter,
  field: number,
  attributes: OtlpAttribute[],
): void {
  for (const { key, value } of attributes) {
    // KeyValue
    writer.beginMessage(field);
    writer.key(1, WIRE_LENGTH_DELIMITED).string(key);
    // KeyValue.value: AnyValue
    writer.beginMessage(2);
    if (typeof value === "string") {
      writer.key(1, WIRE_LENGTH_DELIMITED).string(value);
    } else if (typeof value === "boolean") {
      writer.key(2, WIRE_VARINT).varint(value ? 1 : 0);
    } else if (Number.isSafeInteger(value)) {
      writer.key(3, WIRE_VARINT).int64(value);
    } else {
      writer.key(4, WIRE_FIXED64).double(value);
    }
    writer.endMessage();
    writer.endMessage();
  }
}
