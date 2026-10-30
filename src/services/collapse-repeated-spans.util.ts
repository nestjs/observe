import { ObserveOptions } from "../interfaces/observe-options.interface.js";
import {
  CompleteTraceEventNode,
  OngoingTraceEventNode,
} from "../interfaces/trace-events.interfaces.js";

/**
 * Tag under which a collapsed node records how many calls it stands for.
 *
 * A tag rather than a field of its own so the wire format does not change:
 * `tags` is already on every span and already declared by the collector's
 * contract, so an agent emitting this needs no matching collector release. A
 * collector that does not know the tag stores it like any other and
 * attributes the node as one call; one that does reads the true count here.
 * Namespaced so it reads as the agent's in a span's tag list, and safe from
 * collision: the node it sits on never exists at runtime, so no user code can
 * set tags on it, and the tags of the calls it replaces are dropped.
 *
 * Absent on an ordinary span, which stands for exactly one call. On a node
 * that carries it, `duration` is the *sum* of the replaced calls' durations,
 * `startOffset` and `spanId` are the earliest call's, and `children` holds
 * every child the replaced calls had - which is what keeps the parent's self
 * time and the subtree's class attribution exactly what they were. Ordering
 * among the replaced calls is lost. The node is one event on the wire and is
 * metered as one.
 */
export const SPAN_COLLAPSED_TAG = "observe.collapsed";

/** Resolved form of `ObserveOptions.spanCollapse`. */
export interface SpanCollapseSettings {
  /** Siblings sharing a frame that may stand before the surplus collapses. */
  threshold: number;
  /** Slowest instances kept whole once a group collapses. */
  keepSlowest: number;
}

/**
 * Twenty is above what a hand-written method produces under one parent - a
 * handler calling a repository a dozen times in a loop is still shipped
 * whole - and far below the hundreds a framework hook like `ValidationPipe`
 * produces per GraphQL list query. Three kept instances is enough to show the
 * spread between the slowest calls without the tail of identical ones behind
 * them.
 */
export const DEFAULT_SPAN_COLLAPSE: SpanCollapseSettings = {
  threshold: 20,
  keepSlowest: 3,
};

/**
 * Turns the user-facing option into settings the registry can apply, or
 * `undefined` when collapsing is switched off. Unusable values - a negative
 * count, a fraction, `NaN` - fall back to the default for that field rather
 * than disabling the feature: an option typo should not silently reopen the
 * span flood this exists to stop.
 */
export function resolveSpanCollapseSettings(
  option: ObserveOptions["spanCollapse"],
): SpanCollapseSettings | undefined {
  if (option === false) {
    return undefined;
  }
  return {
    threshold: toInteger(option?.threshold, 1, DEFAULT_SPAN_COLLAPSE.threshold),
    keepSlowest: toInteger(
      option?.keepSlowest,
      0,
      DEFAULT_SPAN_COLLAPSE.keepSlowest,
    ),
  };
}

function toInteger(value: unknown, min: number, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= min
    ? value
    : fallback;
}

/**
 * Collapses repeated siblings throughout a completed span tree, in place.
 *
 * Within one list of siblings, auto spans are grouped by `className` and
 * `methodKey`. A group larger than `threshold` keeps its `keepSlowest`
 * longest-running members and every member that errored as ordinary spans;
 * the rest are replaced by one node that records how many calls it stands
 * for (`SPAN_COLLAPSED_TAG`) and the sum of their durations. Manual spans are never collapsed - a
 * user named each of them deliberately - and ongoing nodes, which a shipped
 * tree should not contain, are left alone.
 *
 * Summing the durations, rather than taking the wall-clock envelope, is what
 * keeps the collector's self-time partition exact: a parent's self time is its
 * duration minus the durations of its children, and the sum over the surviving
 * children is the same as it was over the originals. The collapsed calls'
 * own children are carried across onto the collapsed node for the same reason
 * one level down, and then collapsed among themselves in turn - a repeated
 * frame that always calls the same repeated frame collapses at both levels.
 *
 * Siblings are matched wherever they sit in the list, not only when adjacent:
 * a pipe run once per argument interleaves with the resolver calls it
 * validates for. The collapsed node takes the position of the earliest call
 * it replaces, so ordering relative to the *other* siblings is kept; ordering
 * among the collapsed calls themselves is lost.
 *
 * Returns the new sibling list for the level passed in. Descendant lists are
 * rewritten through their parents' `children`.
 */
export function collapseRepeatedSpans(
  siblings: Array<CompleteTraceEventNode | OngoingTraceEventNode>,
  settings: SpanCollapseSettings,
): Array<CompleteTraceEventNode | OngoingTraceEventNode> {
  const collapsed = collapseSiblings(siblings, settings);
  for (const node of collapsed) {
    if (Array.isArray(node.children) && node.children.length > 0) {
      // Never empty: collapsing replaces repeated siblings, keeping at least
      // one node for each group, so no child list loses all its members.
      node.children = collapseRepeatedSpans(node.children, settings);
    }
  }
  return collapsed;
}

function collapseSiblings(
  siblings: Array<CompleteTraceEventNode | OngoingTraceEventNode>,
  settings: SpanCollapseSettings,
): Array<CompleteTraceEventNode | OngoingTraceEventNode> {
  if (siblings.length <= settings.threshold) {
    return siblings;
  }

  // By class, then by method. Both names are strings the instrumentation made
  // once and V8 has already hashed; a key joining them was a new string to
  // build and hash for every sibling, which made it the costliest line here.
  const groupsByClass = new Map<
    string,
    Map<string, CompleteTraceEventNode[]>
  >();
  for (const node of siblings) {
    if (!isCollapsible(node)) {
      continue;
    }
    let groupsByMethod = groupsByClass.get(node.className);
    if (!groupsByMethod) {
      groupsByMethod = new Map();
      groupsByClass.set(node.className, groupsByMethod);
    }
    const group = groupsByMethod.get(node.methodKey);
    if (group) {
      group.push(node);
    } else {
      groupsByMethod.set(node.methodKey, [node]);
    }
  }

  // Which node each collapsed call is replaced by: the earliest call maps to
  // the collapsed node, the others to nothing.
  const replacements = new Map<
    CompleteTraceEventNode,
    CompleteTraceEventNode
  >();
  const removed = new Set<CompleteTraceEventNode>();

  for (const groupsByMethod of groupsByClass.values()) {
    for (const group of groupsByMethod.values()) {
      if (group.length <= settings.threshold) {
        continue;
      }

      const candidates = group
        .filter((node) => !node.error)
        .sort((a, b) => b.duration - a.duration);
      const surplus = candidates.slice(settings.keepSlowest);
      // A node standing for a single call would be a relabelled span, not an
      // aggregate.
      if (surplus.length < 2) {
        continue;
      }

      const earliest = surplus.reduce((first, node) =>
        compareStart(node, first, siblings) < 0 ? node : first,
      );
      replacements.set(earliest, toCollapsedNode(surplus, earliest));
      for (const node of surplus) {
        if (node !== earliest) {
          removed.add(node);
        }
      }
    }
  }

  if (replacements.size === 0) {
    return siblings;
  }

  const result: Array<CompleteTraceEventNode | OngoingTraceEventNode> = [];
  for (const node of siblings) {
    if (removed.has(node as CompleteTraceEventNode)) {
      continue;
    }
    result.push(replacements.get(node as CompleteTraceEventNode) ?? node);
  }
  return result;
}

/**
 * Earlier of two calls. `startOffset` is the trace clock and decides; nodes
 * with no offset (an older snapshot, or a span opened after its trace ended)
 * fall back to their position in the sibling list, which is insertion order
 * and therefore start order as well.
 */
function compareStart(
  a: CompleteTraceEventNode,
  b: CompleteTraceEventNode,
  siblings: Array<CompleteTraceEventNode | OngoingTraceEventNode>,
): number {
  if (typeof a.startOffset === "number" && typeof b.startOffset === "number") {
    return a.startOffset - b.startOffset;
  }
  return siblings.indexOf(a) - siblings.indexOf(b);
}

function toCollapsedNode(
  surplus: CompleteTraceEventNode[],
  earliest: CompleteTraceEventNode,
): CompleteTraceEventNode {
  let duration = 0;
  let startOffset: number | undefined;
  const children: CompleteTraceEventNode[] = [];
  for (const node of surplus) {
    duration += node.duration;
    if (
      typeof node.startOffset === "number" &&
      (startOffset === undefined || node.startOffset < startOffset)
    ) {
      startOffset = node.startOffset;
    }
    if (Array.isArray(node.children)) {
      children.push(...node.children);
    }
  }

  const collapsed: Omit<CompleteTraceEventNode, "children"> & {
    children?: CompleteTraceEventNode[];
  } = {
    origin: "auto",
    className: earliest.className,
    methodKey: earliest.methodKey,
    // Reads as an aggregate in a waterfall rather than as one more call.
    name: `${earliest.className}.${earliest.methodKey} ×${surplus.length}`,
    tags: { [SPAN_COLLAPSED_TAG]: surplus.length },
    duration,
  };
  if (startOffset !== undefined) {
    collapsed.startOffset = startOffset;
  }
  if (earliest.spanId !== undefined) {
    // A log line written inside the earliest call still resolves to a node.
    // Lines written inside the other collapsed calls resolve to nothing, as
    // they would for any span that was not shipped.
    collapsed.spanId = earliest.spanId;
  }
  // Added when there are any rather than deleted when there are none: a
  // deleted property sends the node into V8's slow dictionary mode.
  if (children.length > 0) {
    collapsed.children = children;
  }
  return collapsed as CompleteTraceEventNode;
}

/**
 * Only completed auto spans collapse. A node still carrying `type` is one that
 * was not shipped as complete: the registry rebuilds the trees it ships
 * without it.
 */
function isCollapsible(
  node: CompleteTraceEventNode | OngoingTraceEventNode,
): node is CompleteTraceEventNode {
  return (
    !("type" in node) &&
    node.origin === "auto" &&
    typeof node.className === "string" &&
    typeof node.methodKey === "string" &&
    typeof node.duration === "number"
  );
}
