import type { CapturedRequest } from "../utils/capture-request.util.js";
import {
  CompleteTraceEventNode,
  OngoingTraceEventNode,
} from "./trace-events.interfaces.js";

export interface RequestSnapshot {
  /**
   * Represents when the request was executed.
   * This is a human-readable timestamp, typically in ISO 8601 format.
   */
  calledAt?: string;

  /**
   * Unique identifier for the trace associated
   */
  traceId: string;

  /**
   * Timestamp when the request started.
   * This is a high-resolution timestamp, typically in milliseconds.
   */
  startTimestamp?: number;

  /**
   * The duration of the request in milliseconds.
   */
  duration?: number;

  /**
   * HTTP, gRPC, Kafka, or other protocol used for the request.
   * This field indicates the type of protocol used for the request.
   */
  protocol: string;

  /**
   * Unique identifier for the operation being traced.
   * This could be a URL path for HTTP requests, a method name for gRPC, etc.
   */
  operationId?: string;

  /**
   * Array of trace events associated with the request.
   * This array contains both ongoing and complete trace events.
   * Ongoing events are those that have started but not yet ended.
   */
  traces: Array<OngoingTraceEventNode | CompleteTraceEventNode>;

  /**
   * Tags associated with the request.
   * Tags are key-value pairs that provide additional context about the request.
   * This field is optional and can be used to capture additional metadata about the request.
   * @example { 'environment': 'production', 'version': '1.0.0' }
   * @default {}
   */
  tags?: Record<string, string | number | boolean>;

  /**
   * Indicates whether an error occurred during the operation represented by the trace span.
   * If undefined, it means no error occurred.
   */
  error?: {
    cls?: string;
    message: string;
    stack?: string;
    tags?: Record<string, string | number | boolean>;
  };

  /**
   * The request's own inputs - headers, and the body when asked for - when
   * `http.capture` decides this request is worth them: it failed, or it ran
   * past `slowerThanMs`. A field of its own rather than part of `error`, so
   * that what triggered the capture never decides where it is read from.
   */
  request?: CapturedRequest;

  /**
   * Optional user identifier associated with the request.
   */
  userId?: string;

  /**
   * Protocol-specific attributes for the request.
   * This field is optional and can be used to capture additional attributes specific to the protocol used
   * (e.g., HTTP method, status code).
   */
  attributes?: {
    /**
     * The HTTP method used for the request (e.g., GET, POST, PUT, DELETE).
     * This field is optional and can be used to capture the HTTP method of the request.
     */
    method?: string;
    /**
     * The status code of the HTTP response.
     * This field is optional and can be used to capture the HTTP status code of the response.
     */
    statusCode?: number;
    /**
     * Original URL of the request. For GraphQL operations this carries the
     * sanitized document instead of the transport's URL: every operation
     * shares one mount path, so the URL says nothing, while the document is
     * what tells two requests to the same root field apart -
     * `{ orders { id } }` and `{ orders { id name total } }` share an
     * operation id but not a document.
     */
    originalUrl?: string;
  };
}
