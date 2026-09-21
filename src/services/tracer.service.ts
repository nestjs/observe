import { Inject, Injectable } from "@nestjs/common";
import { AsyncLocalStorage } from "async_hooks";
import { ObserveAgentSharedBuffer } from "../agent/observe-agent.shared-buffer.js";
import { Gauge, GaugeKind, Summary } from "../custom-metrics/index.js";
import { Counter } from "../custom-metrics/counter.js";
import { ObserveModuleOptionsWithDefaults } from "../interfaces/index.js";
import { TraceSpanDelegate } from "../trace-span.delegate.js";
import { KeyOf } from "../types/key-of.type.js";
import { Path, PathValue } from "../types/path-value.type.js";
import {
  CALLER_METADATA_KEY,
  OBSERVE_OPTIONS,
  TRACE_REGISTRY_KEY,
} from "../observe.constants.js";
import { OperationTraceRegistry } from "./operation-trace.registry.js";

@Injectable()
export class TracerService<
  Store extends Record<string | symbol, unknown> = Record<
    string | symbol,
    unknown
  >,
  TraceKey extends string = "traceId",
> {
  // Each entry has its own label union, so the maps hold the label-agnostic
  // form: pinning them to `Counter<"default">` only forced a cast back out on
  // every read and another one on every write.
  private readonly counters = new Map<string, Counter<any>>();
  private readonly gauges = new Map<string, Gauge<any>>();
  private readonly summaries = new Map<string, Summary<any>>();

  constructor(
    private readonly operationTraceRegistry: OperationTraceRegistry,
    private readonly als: AsyncLocalStorage<Map<KeyOf<Store> | TraceKey, any>>,
    private readonly observeAgentSharedBuffer: ObserveAgentSharedBuffer,
    @Inject(OBSERVE_OPTIONS)
    private readonly options: ObserveModuleOptionsWithDefaults,
  ) {}

  /**
   * Creates a new trace span with the given name and executes the provided callback within that span.
   * The callback can be synchronous or asynchronous.
   */
  async createSpan(
    name: string,
    callback: (span: TraceSpanDelegate) => unknown | Promise<unknown>,
  ) {
    // await new Promise(resolve => setImmediate(resolve));

    const store = this.als.getStore();
    if (!store) {
      throw new Error(
        'AsyncLocalStorage is not initialized. Ensure that you are using the "createSpan" method within an async context.',
      );
    }
    const traceId = this.requireTraceId(store, "createSpan");
    const callerId = store.get(CALLER_METADATA_KEY) as string | undefined;
    return this.operationTraceRegistry.createManualSpan(
      traceId,
      callerId,
      name,
      callback,
    );
  }

  /**
   * Retrieves the active span for the current request.
   * This method should be called within an async context where the AsyncLocalStorage is active.
   * If no active span is found, an error is thrown.
   * @returns {Promise<TraceSpanDelegate>} A promise that resolves to the active span delegate.
   */
  async activeSpan(): Promise<TraceSpanDelegate> {
    // await new Promise((resolve) => setImmediate(resolve));

    const store = this.als.getStore();
    if (!store) {
      throw new Error(
        'AsyncLocalStorage is not initialized. Ensure that you are using the "activeSpan" method within an async context.',
      );
    }
    const traceId = this.requireTraceId(store, "activeSpan");
    const callerId = store.get(CALLER_METADATA_KEY) as string | undefined;
    const activeOngoingEvent = this.operationTraceRegistry.getActiveSpan(
      traceId,
      callerId,
    );
    if (!activeOngoingEvent) {
      throw new Error(
        `No active span found for traceId: ${traceId}. Ensure that a span is created before calling "activeSpan".`,
      );
    }

    let tags = activeOngoingEvent.tags;
    if (!tags) {
      tags = {};
      activeOngoingEvent.tags = tags;
    }

    const traceSpanDelegate = new TraceSpanDelegate(
      // Optional on the shared `TraceSpan` interface, always set on the nodes
      // the registry builds - and `getActiveSpan` only ever returns one of
      // those.
      activeOngoingEvent.spanId ?? "",
      activeOngoingEvent.name,
      tags,
    );

    return traceSpanDelegate;
  }

  /**
   * Captures an error and associates it with the current trace.
   * This method should be called within an async context where the AsyncLocalStorage is active.
   */
  async captureError(
    error: Error,
    tags?: Record<string, string | number | boolean>,
  ) {
    // await new Promise((resolve) => setImmediate(resolve));

    const store = this.als.getStore();
    if (!store) {
      throw new Error(
        'AsyncLocalStorage is not initialized. Ensure that you are using the "captureError" method within an async context.',
      );
    }

    const traceId =
      store.get(TRACE_REGISTRY_KEY as KeyOf<Store>) ??
      store.get(this.options.traceIdKey);
    if (typeof traceId !== "string") {
      // Reporting an error must not raise one. The registry warned and gave up
      // in this case anyway, so the outcome is unchanged.
      return;
    }
    const callerId = store.get(CALLER_METADATA_KEY) as string | undefined;
    this.operationTraceRegistry.captureError(
      traceId,
      callerId,
      error,
      tags ?? {},
    );
  }

  /**
   * Creates or retrieves a counter metric with the specified name.
   * If a counter with the same name already exists, it returns the existing counter.
   * Otherwise, it creates a new counter with the provided parameters.
   * @param name The name of the counter.
   * @returns A Counter instance with the specified name.
   */
  counter<TLabel extends string = "default">(name: string): Counter<TLabel>;
  /**
   * Creates or retrieves a counter metric with the specified name, description, and initial value.
   * If a counter with the same name already exists, it returns the existing counter.
   * Otherwise, it creates a new counter with the provided parameters.
   * @param name The name of the counter.
   * @param attributes An object containing optional description, initialValue, and labels for the counter.
   * @returns A Counter instance with the specified name, description, and initial value.
   */
  counter<TLabel extends string = "default">(
    name: string,
    attributes: {
      description?: string;
      initialValue?: number;
      labels?: TLabel[];
    },
  ): Counter<TLabel>;
  counter<TLabel extends string = "default">(
    name: string,
    attributes?: {
      description?: string;
      initialValue?: number;
      labels?: TLabel[];
    },
  ): Counter<TLabel> {
    const existingRef = this.counters.get(name) as Counter<TLabel> | undefined;
    if (existingRef) {
      const overridableRef = existingRef as any;
      if (attributes?.description) {
        overridableRef.description = attributes.description;
      }
      if (attributes?.labels) {
        overridableRef.labels = attributes.labels;
      }
      if (
        attributes?.initialValue !== undefined &&
        existingRef.getValue() === 0
      ) {
        overridableRef["value"] = attributes.initialValue;
      }
      return existingRef;
    }
    const counter = new Counter<TLabel>(
      name,
      attributes?.description,
      attributes?.initialValue,
      attributes?.labels,
    );
    this.registerCounterChangeHandler(counter);
    this.counters.set(name, counter);
    return counter;
  }

  /**
   * Creates or retrieves a gauge metric with the specified name.
   * If a gauge with the same name already exists, it returns the existing gauge.
   * Otherwise, it creates a new gauge with the provided parameters.
   * The default gauge's kind is "ratio".
   * @param name The name of the gauge.
   * @returns A Gauge instance with the specified name.
   */
  gauge<TLabel extends string = "default">(name: string): Gauge<TLabel>;

  /**
   * Creates or retrieves a gauge metric with the specified name, description, and initial value.
   * If a gauge with the same name already exists, it returns the existing gauge.
   * Otherwise, it creates a new gauge with the provided parameters.
   * @param name The name of the gauge.
   * @param attributes An object containing optional description, initialValue, and labels for the gauge. Can also include kind (e.g., "additive" or "ratio").
   * @returns A Gauge instance with the specified name, description, kind, and initial value.
   */
  gauge<TLabel extends string = "default">(
    name: string,
    attributes: {
      description?: string;
      initialValue?: number;
      labels?: TLabel[];
      kind?: GaugeKind;
    },
  ): Gauge<TLabel>;
  gauge<TLabel extends string = "default">(
    name: string,
    attributes?: {
      description?: string;
      initialValue?: number;
      labels?: TLabel[];
      kind?: GaugeKind;
    },
  ): Gauge<TLabel> {
    const existingRef = this.gauges.get(name) as Gauge<TLabel> | undefined;
    if (existingRef) {
      const overridableRef = existingRef as any;
      if (attributes?.description) {
        overridableRef.description = attributes.description;
      }
      if (attributes?.labels) {
        overridableRef.labels = attributes.labels;
      }
      if (
        attributes?.initialValue !== undefined &&
        existingRef.getValue() === 0
      ) {
        overridableRef["value"] = attributes.initialValue;
      }
      if (attributes?.kind) {
        overridableRef.kind = attributes.kind;
      }

      return existingRef;
    }
    const gauge = new Gauge<TLabel>(name, attributes ?? {});
    this.registerGaugeChangeHandler(gauge);
    this.gauges.set(name, gauge);
    return gauge;
  }

  /**
   * Creates or retrieves a summary metric with the specified name.
   * If a summary with the same name already exists, it returns the existing summary.
   * Otherwise, it creates a new summary with the provided parameters.
   * @param name The name of the summary.
   * @returns A Summary instance with the specified name.
   */
  summary<TLabel extends string = "default">(name: string): Summary<TLabel>;
  /**
   * Creates or retrieves a summary metric with the specified name and description.
   * If a summary with the same name already exists, it returns the existing summary.
   * Otherwise, it creates a new summary with the provided parameters.
   * @param name The name of the summary.
   * @param attributes An object containing optional description and labels for the
   * summary, plus `sampleSize` - how many observations per label are retained to
   * compute quantiles from, which bounds the summary's memory under load.
   * @returns A Summary instance with the specified name and description.
   */
  summary<TLabel extends string = "default">(
    name: string,
    attributes: {
      description?: string;
      labels?: TLabel[];
      sampleSize?: number;
    },
  ): Summary<TLabel>;
  summary<TLabel extends string = "default">(
    name: string,
    attributes?: {
      description?: string;
      labels?: TLabel[];
      sampleSize?: number;
    },
  ): Summary<TLabel> {
    const existingRef = this.summaries.get(name) as Summary<TLabel> | undefined;
    if (existingRef) {
      const overridableRef = existingRef as any;
      if (attributes?.description) {
        overridableRef.description = attributes.description;
      }
      if (attributes?.labels) {
        overridableRef.labels = attributes.labels;
      }
      return existingRef;
    }
    const summary = new Summary<TLabel>(name, attributes ?? {});
    this.registerSummaryChangeHandler(summary);
    this.summaries.set(name, summary);
    return summary;
  }

  /**
   * The id of the trace currently in flight, or `null` outside one.
   *
   * Unlike `getAttribute`/`activeSpan`, this does not throw when there is no
   * active store - reading the trace id to forward it downstream (an outgoing
   * HTTP header, gRPC metadata, a queued job payload) is exactly the kind of
   * call that may legitimately happen outside a traced context, and a thrown
   * error there would force every caller to wrap it in a try/catch just to
   * propagate an id that simply isn't there yet.
   */
  currentTraceId(): string | null {
    const store = this.als.getStore();
    const traceId = store?.get(this.options.traceIdKey);
    return typeof traceId === "string" ? traceId : null;
  }

  /**
   * Sets an attribute on the current trace.
   * For example, you can use this to add metadata to the current request trace for later use and retrieval.
   * This method should be called within an async context where the AsyncLocalStorage is active.
   * @param key The attribute key.
   * @param value The attribute value.
   */
  setAttribute<P extends Path<Store>>(key: P, value: PathValue<Store, P>) {
    const store = this.als.getStore();
    if (!store) {
      throw new Error(
        'AsyncLocalStorage is not initialized. Ensure that you are using the "setAttribute" method within an async context.',
      );
    }

    store.set(key, value);
  }

  /**
   * Retrieves an attribute from the current trace (request context).
   * This allows you to access metadata that was set earlier in the request lifecycle.
   * This method should be called within an async context where the AsyncLocalStorage is active.
   * @param key The attribute key.
   * @returns The attribute value or undefined if not found.
   */
  getAttribute<P extends Path<Store>>(key: P): PathValue<Store, P> | undefined {
    const store = this.als.getStore();
    if (!store) {
      throw new Error(
        'AsyncLocalStorage is not initialized. Ensure that you are using the "getAttribute" method within an async context.',
      );
    }

    return store.get(key);
  }

  /**
   * Reads the trace id the request was opened under. Its absence means the call
   * is outside any traced operation, which is the same mistake as calling these
   * methods with no async context at all - and is reported the same way.
   */
  private requireTraceId(
    store: Map<KeyOf<Store>, unknown>,
    method: string,
  ): string {
    const traceId =
      store.get(TRACE_REGISTRY_KEY as KeyOf<Store>) ??
      store.get(this.options.traceIdKey);
    if (typeof traceId !== "string") {
      throw new Error(
        `No trace id found in the current context. Ensure that you are using the "${method}" method within a traced operation.`,
      );
    }
    return traceId;
  }

  private registerCounterChangeHandler<TLabel extends string>(
    counter: Counter<TLabel>,
  ): void {
    counter["_onChange"] = (self: Counter<TLabel>) => {
      this.observeAgentSharedBuffer.upsertCustomMetric(self);
    };
  }

  private registerGaugeChangeHandler<TLabel extends string>(
    gauge: Gauge<TLabel>,
  ): void {
    gauge["_onChange"] = (self: Gauge<TLabel>) => {
      this.observeAgentSharedBuffer.upsertCustomMetric(self);
    };
  }

  private registerSummaryChangeHandler<TLabel extends string>(
    summary: Summary<TLabel>,
  ): void {
    summary["_onChange"] = (self: Summary<TLabel>) => {
      this.observeAgentSharedBuffer.upsertCustomMetric(self);
    };
  }
}
