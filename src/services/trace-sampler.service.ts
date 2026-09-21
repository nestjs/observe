import { Inject, Injectable } from "@nestjs/common";
import { ObserveModuleOptionsWithDefaults } from "../interfaces/observe-options.interface.js";
import { OBSERVE_OPTIONS } from "../observe.constants.js";

@Injectable()
export class TraceSamplerService {
  constructor(
    @Inject(OBSERVE_OPTIONS)
    private readonly options: ObserveModuleOptionsWithDefaults,
  ) {}

  /**
   * Determines if a trace should be captured based on the protocol and attributes.
   * @param protocol - The protocol type ('http', 'rpc', 'grpc' or 'graphql').
   * @param attributes - The attributes relevant to the protocol.
   * @returns boolean indicating whether the trace should be captured.
   */
  shouldCapture(
    protocol: "http",
    attributes: { url: string; method: string },
  ): boolean;
  shouldCapture(
    protocol: "rpc",
    attributes: { transport: string; ctx: Record<string, any> },
  ): boolean;
  shouldCapture(
    protocol: "grpc",
    attributes: { call: Record<string, any> },
  ): boolean;
  shouldCapture(
    protocol: "graphql",
    attributes: { operationId: string },
  ): boolean;
  shouldCapture(
    protocol: "ws",
    attributes: { gateway: string; pattern: string },
  ): boolean;
  shouldCapture(
    protocol: "http" | "rpc" | "grpc" | "graphql" | "ws",
    attributes: {
      gateway?: string;
      pattern?: string;
      url?: string;
      method?: string;
      transport?: string;
      ctx?: Record<string, any>;
      call?: Record<string, any>;
      operationId?: string;
    },
  ): boolean {
    if (!this.options.tracesSampleRate) {
      return true; // Always capture if sample rate is not set
    }

    if (typeof this.options.tracesSampleRate === "number") {
      if (this.options.tracesSampleRate >= 1) {
        return true; // Capture all traces if sample rate is 100%
      }
      return Math.random() < this.options.tracesSampleRate; // Randomly capture traces based on sample rate
    }

    return this.options.tracesSampleRate(protocol, attributes);
  }
}
