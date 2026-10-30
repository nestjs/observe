import {
  Controller,
  Get,
  INestApplication,
  Module,
  Param,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import request from "supertest";
import { ObserveOptions } from "../interfaces/observe-options.interface.js";
import { createObserveModule } from "../observe.module.js";
import { TracerService } from "../services/tracer.service.js";
import {
  listenOnLoopback,
  testObserveOptions,
} from "../testing/observe-harness.js";
import { w3cTraceIdOf } from "../utils/trace-context.util.js";
import { SpanKind } from "./otlp-span.mapper.js";

/**
 * Where the suite finds Jaeger - all-in-one, with its OTLP/HTTP receiver and
 * its query API:
 *
 *   docker run -d -p 4318:4318 -p 16686:16686 jaegertracing/jaeger:2.22.0
 *
 * Read back through query API v3, which answers in OTLP's own JSON: 2.22
 * answers 404 for the older `/api/services` and `/api/traces/:id`.
 */
const JAEGER_OTLP = process.env.JAEGER_OTLP_ENDPOINT ?? "http://127.0.0.1:4318";
const JAEGER_QUERY = process.env.JAEGER_QUERY_URL ?? "http://127.0.0.1:16686";

const jaegerReachable = await fetch(`${JAEGER_QUERY}/api/v3/services`, {
  signal: AbortSignal.timeout(500),
})
  .then((response) => response.ok)
  .catch(() => false);

interface OtlpJsonValue {
  stringValue?: string;
  intValue?: string;
  boolValue?: boolean;
  doubleValue?: number;
}

interface OtlpJsonAttribute {
  key: string;
  value: OtlpJsonValue;
}

interface OtlpJsonResourceSpans {
  resource?: { attributes?: OtlpJsonAttribute[] };
  scopeSpans?: Array<{
    spans?: Array<{
      traceId: string;
      spanId: string;
      parentSpanId?: string;
      name: string;
      kind?: number;
      attributes?: OtlpJsonAttribute[];
    }>;
  }>;
}

/** A span as Jaeger stores it, with the service it came from. */
interface StoredSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string | undefined;
  name: string;
  kind: number | undefined;
  service: string | undefined;
  attributes: Record<string, unknown>;
}

const valueOf = (value: OtlpJsonValue) =>
  value.intValue === undefined
    ? value.stringValue ?? value.boolValue ?? value.doubleValue
    : Number(value.intValue);

const attributesOf = (attributes: OtlpJsonAttribute[] = []) =>
  Object.fromEntries(attributes.map(({ key, value }) => [key, valueOf(value)]));

/**
 * The trace's spans as Jaeger stores them, once it holds at least
 * `minSpans`. The answer streams as one JSON object per chunk, a line each.
 */
async function jaegerTrace(
  traceId: string,
  minSpans: number,
  timeoutMs = 15_000,
): Promise<StoredSpan[]> {
  const deadline = Date.now() + timeoutMs;
  let spans: StoredSpan[] = [];
  while (Date.now() < deadline) {
    const response = await fetch(`${JAEGER_QUERY}/api/v3/traces/${traceId}`);
    if (response.ok) {
      spans = (await response.text())
        .split("\n")
        .filter((line) => line.trim() !== "")
        .flatMap(
          (line) =>
            (
              JSON.parse(line) as {
                result?: { resourceSpans?: OtlpJsonResourceSpans[] };
              }
            ).result?.resourceSpans ?? [],
        )
        .flatMap((resourceSpans) => {
          const service = attributesOf(resourceSpans.resource?.attributes)[
            "service.name"
          ] as string | undefined;
          return (resourceSpans.scopeSpans ?? []).flatMap(
            (scopeSpans) =>
              scopeSpans.spans?.map((span) => ({
                traceId: span.traceId,
                spanId: span.spanId,
                parentSpanId: span.parentSpanId || undefined,
                name: span.name,
                kind: span.kind,
                service,
                attributes: attributesOf(span.attributes),
              })) ?? [],
          );
        });
      if (spans.length >= minSpans) {
        return spans;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `Jaeger holds ${spans.length} spans of trace ${traceId}, not ${minSpans}.`,
  );
}

let backUrl = "";

@Controller()
class FrontController {
  constructor(private readonly tracer: TracerService) {}

  @Get("checkout/:id")
  async checkout(@Param("id") id: string) {
    const response = await fetch(`${backUrl}/stock/${id}`);
    await response.text();
    return { traceId: this.tracer.currentTraceId() };
  }
}

@Controller()
class BackController {
  @Get("stock/:id")
  stock(@Param("id") id: string) {
    return { id, available: 3 };
  }
}

async function boot(
  controller: new (...args: any[]) => unknown,
  overrides: Partial<ObserveOptions>,
) {
  const { ObserveModule, ObserveInstrument } = createObserveModule();

  @Module({
    imports: [ObserveModule.forRoot(testObserveOptions(overrides))],
    controllers: [controller],
  })
  class AppModule {}

  return NestFactory.create(AppModule, {
    instrument: ObserveInstrument,
    logger: false,
  });
}

/**
 * The exporter against a real OpenTelemetry backend: Jaeger decodes the
 * export with the collector's own OTLP receiver, stores it, and answers for
 * it through its query API - which is the proof that matters. Two services,
 * one exporting protobuf and one JSON, one trace between them.
 *
 * Skipped when no Jaeger answers, like the suites that need a database.
 */
describe.skipIf(!jaegerReachable)(
  "ObserveModule: OTLP export into Jaeger",
  () => {
    const run = Date.now().toString(36);
    let front: INestApplication;
    let frontUrl = "";
    let back: INestApplication;

    beforeAll(async () => {
      back = await boot(BackController, {
        serviceId: "back",
        flushInterval: 1000,
        otlp: {
          endpoint: JAEGER_OTLP,
          protocol: "http/json",
          serviceName: `observe-back-${run}`,
        },
      });
      backUrl = await listenOnLoopback(back);

      front = await boot(FrontController, {
        serviceId: "front",
        flushInterval: 1000,
        otlp: { endpoint: JAEGER_OTLP, serviceName: `observe-front-${run}` },
      });
      frontUrl = await listenOnLoopback(front);
    });

    afterAll(async () => {
      await front?.close();
      await back?.close();
    });

    it("stores two services' spans as one trace, the far server span under the near client span", async () => {
      const response = await request(frontUrl).get("/checkout/7").expect(200);
      const traceId = w3cTraceIdOf(
        (response.body as { traceId: string }).traceId,
      );

      // front: server, controller, client; back: server, controller.
      const spans = await jaegerTrace(traceId, 5);
      const byName = (name: string) =>
        spans.find((span) => span.name === name)!;

      const frontServer = byName("GET /checkout/:id");
      const frontController = byName("FrontController.checkout");
      const frontClient = spans.find((span) => span.kind === SpanKind.CLIENT)!;
      const backServer = byName("GET /stock/:id");
      const backController = byName("BackController.stock");

      expect(frontServer.service).toBe(`observe-front-${run}`);
      expect(backServer.service).toBe(`observe-back-${run}`);
      expect(frontServer.kind).toBe(SpanKind.SERVER);
      expect(frontServer.parentSpanId).toBeUndefined();
      expect(frontController.parentSpanId).toBe(frontServer.spanId);
      expect(frontClient.parentSpanId).toBe(frontController.spanId);
      expect(backServer.parentSpanId).toBe(frontClient.spanId);
      expect(backController.parentSpanId).toBe(backServer.spanId);
      expect(frontServer.attributes["http.route"]).toBe("/checkout/:id");
      expect(frontServer.attributes["http.response.status_code"]).toBe(200);
    });

    it("puts a request that arrived with a traceparent under the caller's span, in the caller's trace", async () => {
      const callerTraceId = w3cTraceIdOf(`jaeger-${run}`);
      const callerSpanId = "00f067aa0ba902b7";
      await request(frontUrl)
        .get("/checkout/8")
        .set("traceparent", `00-${callerTraceId}-${callerSpanId}-01`)
        .expect(200);

      const spans = await jaegerTrace(callerTraceId, 5);
      const frontServer = spans.find(
        (span) => span.name === "GET /checkout/:id",
      )!;

      expect(new Set(spans.map((span) => span.traceId))).toEqual(
        new Set([callerTraceId]),
      );
      expect(frontServer.parentSpanId).toBe(callerSpanId);
    });
  },
);
