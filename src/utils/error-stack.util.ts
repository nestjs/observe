import { types } from "node:util";

/**
 * An error's `stack`, read and rewritten by the agent without that read being
 * the one that fixes its first line.
 *
 * V8 keeps an error's frames from the moment it is made, but writes the text
 * - a first line from its name and message, then the frames - when `stack` is
 * first read. Until then an application can still change the message, and the
 * stack it logs afterwards shows the change: a service masks an id in
 * `error.message` before rethrowing, an exception filter replaces the message
 * altogether. The agent reads the stack before any of that - every traced call
 * an error leaves relabels a frame in it, and the root span ships it - and a
 * plain read there left the original message in the stack for good: in the
 * application's own log, and in the payload, beside a masked `message`.
 *
 * So on first contact with a stack V8 has not written out yet, the agent
 * writes it with a marker in place of the message, keeps the frames, and puts
 * an accessor in place of `stack`. It reads and rewrites the frames it keeps;
 * the first line is written when the application reads the stack, from the
 * message as it is then, and from there on `stack` is the plain string it
 * would have been. A stack that is written already - read before, assigned, as
 * mysql2's promise wrapper does - is left as it is: a later change of the
 * message would not have reached it without the agent either.
 */
interface HeldStack {
  /** Everything under the first line, from its line break on. */
  frames: string;

  /** The first line, written from the error as it is now. */
  firstLine: () => string;

  /**
   * The accessor standing in for `stack`. Anything else found there means
   * the application has read or replaced the stack since, and it is a string
   * like any other again.
   */
  get: () => string;
}

/**
 * Every error the agent has looked at, with the frames it keeps for it - or
 * nothing, for a stack it left as it was. Decided once, on first contact.
 */
const heldStacks = new WeakMap<Error, HeldStack | undefined>();

/**
 * Stands in for the message while the stack is written. Made of characters no
 * message an error is given by accident contains, so it is found where it is.
 */
const MESSAGE_MARKER = "\u0000nestjs-observe:message\u0000";

/**
 * Whether the message can be set aside for the marker and put back exactly:
 * an own data property that is writable, or none at all - `new Error()` - on
 * an error that can take one. A message behind an accessor (`DOMException`)
 * runs code to set, and is not touched.
 */
function messageIsReplaceable(err: Error): boolean {
  for (
    let holder: object | null = err;
    holder !== null;
    holder = Object.getPrototypeOf(holder) as object | null
  ) {
    const descriptor = Reflect.getOwnPropertyDescriptor(holder, "message");
    if (descriptor !== undefined) {
      return (
        "value" in descriptor &&
        descriptor.writable === true &&
        (holder === err || Object.isExtensible(err))
      );
    }
  }
  return Object.isExtensible(err);
}

function holdStack(err: Error): HeldStack | undefined {
  // Sealing makes `stack` non-configurable, and so the accessor impossible:
  // the stack is read as it is. Asked before anything else, since asking for
  // the descriptor of a stack not written yet writes it on Node 20.
  if (
    types.isProxy(err) ||
    Object.isSealed(err) ||
    !messageIsReplaceable(err)
  ) {
    return undefined;
  }

  const ownMessage = Object.hasOwn(err, "message");
  const message: unknown = err.message;
  let written: unknown;
  let markedFirstLine: string;
  try {
    err.message = MESSAGE_MARKER;
    written = err.stack;
    markedFirstLine = Error.prototype.toString.call(err);
  } finally {
    if (ownMessage) {
      err.message = message as string;
    } else {
      delete (err as { message?: unknown }).message;
    }
  }
  if (typeof written !== "string") {
    return undefined;
  }
  const at = written.indexOf(MESSAGE_MARKER);
  if (at === -1) {
    // Written before the agent saw it: left as it is.
    return undefined;
  }

  const before = written.slice(0, at);
  const after = written.slice(at + MESSAGE_MARKER.length);
  const lineEnd = after.indexOf("\n");
  const restOfLine = lineEnd === -1 ? after : after.slice(0, lineEnd);
  const frames = lineEnd === -1 ? "" : after.slice(lineEnd);
  // The first line as V8 writes it - `name: message`, or the name alone for
  // an empty message - is written again the same way; any other shape (Node's
  // `TypeError [ERR_X]: message`) keeps what surrounds the message.
  const firstLine =
    `${before}${MESSAGE_MARKER}${restOfLine}` === markedFirstLine
      ? () => Error.prototype.toString.call(err)
      : () => `${before}${err.message}${restOfLine}`;

  const own = Reflect.getOwnPropertyDescriptor(err, "stack");
  const enumerable = own?.enumerable ?? false;
  const settle = (value: unknown) =>
    Reflect.defineProperty(err, "stack", {
      value,
      writable: true,
      enumerable,
      configurable: true,
    });

  if (own?.configurable !== true || frames.includes(MESSAGE_MARKER)) {
    // Written with the marker, and no way to keep it from the application:
    // write it out now, as it would have been written at this read.
    settle(firstLine() + frames.split(MESSAGE_MARKER).join(String(message)));
    return undefined;
  }

  const held: HeldStack = {
    frames,
    firstLine,
    get: () => {
      // The application's read: the one that fixes the first line.
      const text = held.firstLine() + held.frames;
      settle(text);
      return text;
    },
  };
  const installed = Reflect.defineProperty(err, "stack", {
    get: held.get,
    set: settle,
    enumerable,
    configurable: true,
  });
  if (!installed) {
    settle(firstLine() + frames);
    return undefined;
  }
  return held;
}

/** The frames the agent keeps for an error, if it still does. */
function heldStackOf(err: Error): HeldStack | undefined {
  if (!heldStacks.has(err)) {
    let held: HeldStack | undefined;
    try {
      held = holdStack(err);
    } catch {
      // A name, message or stack that throws on being read or set: such an
      // error is read as it is, which throws without the agent too.
      held = undefined;
    }
    heldStacks.set(err, held);
  }
  const held = heldStacks.get(err);
  return held !== undefined &&
    Object.getOwnPropertyDescriptor(err, "stack")?.get === held.get
    ? held
    : undefined;
}

/**
 * An error's stack as it reads now, for the agent's own use: its first line
 * is still the application's to change.
 */
export function readStack(err: Error): unknown {
  const held = heldStackOf(err);
  return held === undefined ? err.stack : held.firstLine() + held.frames;
}

/**
 * Rewrites the frames of an error's stack, likewise.
 *
 * `rewrite` is given the frames alone where the agent keeps them, and the
 * whole text where the stack is a plain string - so it must only match what
 * follows a line break.
 */
export function rewriteStackFrames(
  err: Error,
  rewrite: (stack: string) => string,
): void {
  const held = heldStackOf(err);
  if (held !== undefined) {
    held.frames = rewrite(held.frames);
    return;
  }
  const stack: unknown = err.stack;
  if (typeof stack !== "string") {
    return;
  }
  const rewritten = rewrite(stack);
  if (rewritten === stack) {
    return;
  }
  try {
    err.stack = rewritten;
  } catch {
    // Some errors ship a read-only `stack`; what the agent rewrites there is
    // cosmetic, so leaving it as it is beats masking the original failure.
  }
}
