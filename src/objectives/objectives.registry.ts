import {
  Injectable,
  Logger,
  OnModuleInit,
  RequestMethod,
} from "@nestjs/common";
import { DiscoveryService, MetadataScanner } from "@nestjs/core";
import { RequestSnapshot } from "../interfaces/request-snapshot.interface.js";
import {
  OBJECTIVES_METADATA,
  ObjectiveOptions,
  objectiveProblems,
  toDeclaredObjective,
  unknownObjectiveFields,
} from "./objective.decorator.js";

/** One handler's objectives, with the route it was seen to serve. */
export interface ObjectiveDeclaration {
  /** `OrdersController.create`. */
  handler: string;
  operationId: string;
  method?: string;
  objectives: ObjectiveOptions[];
}

/**
 * How often a declaration is restated while the process runs. Once per
 * process covers every deploy; the restatement covers a batch that never
 * arrived, so a dropped one costs an hour of the SLO, not a release.
 */
const RESTATE_EVERY_MS = 60 * 60 * 1000;

/**
 * How many spans of a trace are searched for the handler's own. It sits under
 * whatever wraps it - each class middleware, and each interceptor that awaits
 * the handler, nests it one level deeper - but above everything it calls, so
 * a breadth-first search meets it long before this.
 */
const MAX_SPANS_SEARCHED = 200;

/**
 * The collector's bounds on a declaration. It validates a batch whole, so one
 * declaration past any of them would cost every snapshot in the batch - and
 * again at every restatement.
 */
const MAX_OBJECTIVES_PER_HANDLER = 10;
const MAX_HANDLER_LENGTH = 255;
const MAX_ROUTE_LENGTH = 255;
const MAX_METHOD_LENGTH = 10;

/** `@nestjs/common`'s METHOD_METADATA - what `@Get()`, `@Post()` and the rest write. */
const METHOD_METADATA = "method";
/** `@nestjs/common`'s PATH_METADATA and VERSION_METADATA, on the controller and the handler. */
const PATH_METADATA = "path";
const VERSION_METADATA = "__version__";

/** How many values a route decorator was given: an array's length, else one. */
const entries = (value: unknown) =>
  Array.isArray(value) ? Math.max(value.length, 1) : 1;

interface HandlerObjectives {
  objectives: ObjectiveOptions[];
  /**
   * The method the handler is routed for, when it is routed for one: a GET
   * handler also answers HEAD, and is declared under GET whichever arrives.
   * Absent for `@All()` and for handlers off HTTP.
   */
  method?: string;
}

/**
 * What the application declares with `@Objective`, and the moment to say so.
 *
 * The decorators are read at boot, keyed by `Class.method` - the name a
 * request's handler span carries. A route is not known until a request takes
 * it, and taking it is the one way to know the route exactly as the
 * collector will key it, prefix and version included. So each completed
 * request is matched to a declaring handler, and the first match per route is
 * handed to the batch being built.
 */
@Injectable()
export class ObjectivesRegistry implements OnModuleInit {
  private readonly logger = new Logger("ObserveObjectives");
  private readonly byHandler = new Map<string, HandlerObjectives>();
  private readonly statedAt = new Map<string, number>();
  private readonly refusedRoutes = new Set<string>();
  private readonly refusedRenamedHandlers = new Set<string>();

  constructor(
    private readonly discoveryService: DiscoveryService,
    private readonly metadataScanner: MetadataScanner,
  ) {}

  onModuleInit() {
    for (const wrapper of this.discoveryService.getControllers()) {
      const metatype = wrapper.metatype as
        | { name: string; prototype: Record<string, unknown> }
        | undefined;
      if (!metatype?.prototype) {
        continue;
      }
      for (const methodName of this.metadataScanner.getAllMethodNames(
        metatype.prototype,
      )) {
        const handlerRef = metatype.prototype[methodName] as object;
        const declared: ObjectiveOptions[] | undefined = Reflect.getMetadata(
          OBJECTIVES_METADATA,
          handlerRef,
        );
        if (!declared?.length) {
          continue;
        }
        const handler = `${metatype.name}.${methodName}`;
        const routes = this.routeCount(metatype, handlerRef);
        if (routes > 1) {
          this.logger.warn(
            `@Objective on ${handler} ignored: it serves ${routes} routes, and an SLO watches one - give each route a handler of its own to declare it.`,
          );
          continue;
        }
        const objectives = this.acceptedObjectives(handler, declared);
        if (objectives.length > 0) {
          this.byHandler.set(handler, {
            objectives,
            method: this.routedMethod(handlerRef),
          });
        }
      }
    }
  }

  /**
   * What of a handler's declarations the collector will take: each checked
   * against its bounds, stripped to the fields it knows, and no more of them
   * than it accepts for one handler. Everything left out is said at boot, once.
   */
  private acceptedObjectives(
    handler: string,
    declared: ObjectiveOptions[],
  ): ObjectiveOptions[] {
    if (handler.length > MAX_HANDLER_LENGTH) {
      this.logger.warn(
        `@Objective on ${handler} ignored: a handler name is at most ${MAX_HANDLER_LENGTH} characters.`,
      );
      return [];
    }
    const accepted: ObjectiveOptions[] = [];
    for (const objective of declared) {
      const problems = objectiveProblems(objective);
      if (problems.length > 0) {
        this.logger.warn(
          `@Objective on ${handler} ignored: ${problems.join("; ")}.`,
        );
        continue;
      }
      const unknown = unknownObjectiveFields(objective);
      if (unknown.length > 0) {
        this.logger.warn(
          `@Objective on ${handler}: ${unknown.join(", ")} not sent - an objective has availability, latency, windowDays and name.`,
        );
      }
      accepted.push(toDeclaredObjective(objective));
    }
    if (accepted.length > MAX_OBJECTIVES_PER_HANDLER) {
      this.logger.warn(
        `@Objective on ${handler}: only the first ${MAX_OBJECTIVES_PER_HANDLER} of ${accepted.length} are sent - a handler declares at most ${MAX_OBJECTIVES_PER_HANDLER}.`,
      );
      return accepted.slice(0, MAX_OBJECTIVES_PER_HANDLER);
    }
    return accepted;
  }

  /**
   * How many routes a handler is mounted on: its controller's paths, times its
   * own, times the versions it answers. A declaration names one route, and
   * the SLO it makes is the handler's, so a handler on several would move
   * that SLO from route to route with every restatement.
   */
  private routeCount(metatype: object, handlerRef: object): number {
    const versions: unknown =
      Reflect.getMetadata(VERSION_METADATA, handlerRef) ??
      Reflect.getMetadata(VERSION_METADATA, metatype);
    return (
      entries(Reflect.getMetadata(PATH_METADATA, metatype)) *
      entries(Reflect.getMetadata(PATH_METADATA, handlerRef)) *
      entries(versions)
    );
  }

  private routedMethod(handlerRef: object): string | undefined {
    const routed = Reflect.getMetadata(METHOD_METADATA, handlerRef) as
      | RequestMethod
      | undefined;
    if (routed === undefined || routed === RequestMethod.ALL) {
      return undefined;
    }
    return RequestMethod[routed];
  }

  get size(): number {
    return this.byHandler.size;
  }

  /**
   * The declaration a completed request brings due, if any: its handler
   * declares objectives, and this route has not been stated for them within
   * the restatement interval.
   */
  declarationFor(
    snapshot: RequestSnapshot,
    now = Date.now(),
  ): ObjectiveDeclaration | undefined {
    if (this.byHandler.size === 0 || !snapshot.operationId) {
      return undefined;
    }
    const handler = this.handlerOf(snapshot.traces);
    if (!handler) {
      return undefined;
    }
    // A renamed request reports under the application's own name, and the
    // collector keeps one SLO per handler: declared from requests named per
    // call, that SLO would move to each new name in turn - the reason a
    // handler mounted on several routes is refused at boot.
    if (snapshot.attributes?.defaultOperationId !== undefined) {
      if (!this.refusedRenamedHandlers.has(handler)) {
        this.refusedRenamedHandlers.add(handler);
        this.logger.warn(
          `@Objective on ${handler} not declared for requests renamed with setOperationId: an SLO watches one route, and each name is a route of its own.`,
        );
      }
      return undefined;
    }
    const declared = this.byHandler.get(handler)!;
    // Routed for one method: that one, whatever the request was - a HEAD
    // probe of a GET route is still the GET route.
    const method = declared.method ?? snapshot.attributes?.method;
    const route = `${handler} ${method ?? ""} ${snapshot.operationId}`;
    if (snapshot.operationId.length > MAX_ROUTE_LENGTH) {
      if (!this.refusedRoutes.has(route)) {
        this.refusedRoutes.add(route);
        this.logger.warn(
          `@Objective on ${handler} not declared for a route longer than ${MAX_ROUTE_LENGTH} characters.`,
        );
      }
      return undefined;
    }
    // Only a handler routed for every method is declared under the request's
    // own, and Node parses one longer than the collector takes: UNSUBSCRIBE.
    // Nothing is stated, so the next request with an ordinary method declares
    // the route as usual.
    if (method !== undefined && method.length > MAX_METHOD_LENGTH) {
      if (!this.refusedRoutes.has(route)) {
        this.refusedRoutes.add(route);
        this.logger.warn(
          `@Objective on ${handler} not declared for a ${method} request: a method is at most ${MAX_METHOD_LENGTH} characters.`,
        );
      }
      return undefined;
    }
    const stated = this.statedAt.get(route);
    if (stated !== undefined && now - stated < RESTATE_EVERY_MS) {
      return undefined;
    }
    this.statedAt.set(route, now);
    return {
      handler,
      operationId: snapshot.operationId,
      ...(method ? { method } : {}),
      objectives: declared.objectives,
    };
  }

  /**
   * The declaring handler whose span sits nearest the root: the request's own
   * handler, however many middlewares and interceptors wrap it.
   */
  private handlerOf(
    roots: RequestSnapshot["traces"] | undefined,
  ): string | undefined {
    const queue = [...(roots ?? [])];
    for (let searched = 0; searched < queue.length; searched++) {
      if (searched >= MAX_SPANS_SEARCHED) {
        return undefined;
      }
      const node = queue[searched];
      const key = `${node.className}.${node.methodKey}`;
      if (this.byHandler.has(key)) {
        return key;
      }
      queue.push(...(node.children ?? []));
    }
    return undefined;
  }
}
