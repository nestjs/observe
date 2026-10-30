import { TraceSpan } from "./trace-span.interface.js";

export interface OngoingTraceEventNode extends TraceSpan {
  /**
   * `"start"` while the call runs, `"end"` once it has returned. A node that
   * has ended keeps its other fields where they are - `startTime`, an empty
   * `children` - until its trace is handed off, when the tree is rebuilt into
   * `CompleteTraceEventNode`s holding only what is shipped.
   */
  type: "start" | "end";
  /**
   * Represents the host class name, which is the class where the method being traced is defined.
   */
  className: string;
  /**
   * Represents the name of the method being traced.
   */
  methodKey: string;
  /**
   * Timestamp when the trace event started.
   * This is a high-resolution timestamp, typically in milliseconds.
   */
  startTime: number;
  /**
   * Milliseconds between the start of the trace root and the start of this span.
   *
   * Captured when the span opens and carried through to the completed node,
   * which has no `startTime`. Undefined when the parent snapshot has already
   * been cleaned up.
   */
  startOffset?: number;
  /**
   * Children trace events for ongoing trace events.
   * This is an array of either `CompleteTraceEventNode` or `OngoingTraceEventNode`.
   * It allows for nested trace events, where ongoing events can have children that are
   * either complete or still ongoing.
   */
  children: Array<CompleteTraceEventNode | OngoingTraceEventNode>;
  /**
   * Optional parent node for ongoing trace events.
   * Undefined for root nodes, and once the node has ended.
   */
  parent?: OngoingTraceEventNode;
}

export interface CompleteTraceEventNode extends TraceSpan {
  /**
   * Represents the host class name, which is the class where the method being traced is defined.
   */
  className: string;
  /**
   * Represents the name of the method being traced.
   */
  methodKey: string;
  /**
   * The duration of the trace event in milliseconds.
   * This is calculated as the difference between the start time and end time.
   */
  duration: number;
  /**
   * Milliseconds between the start of the trace root and the start of this span.
   *
   * Together with `duration` this places the span on the trace's shared clock,
   * which is what makes a real waterfall possible: siblings that overlap can be
   * drawn overlapping instead of being laid end to end. Without it a consumer can
   * only render nesting and relative width.
   *
   * Optional: spans reported by agents older than this field carry no offset.
   */
  startOffset?: number;
  /**
   * Children trace events for nested trace events.
   * All children should be `CompleteTraceEventNode` instances, otherwise the parent node would not be complete.
   */
  children: Array<CompleteTraceEventNode>;
}
