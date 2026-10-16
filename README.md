<p align="center">
  <a href="https://observe.nestjs.com" target="_blank"><img src="https://nestjs.com/img/logo-small.svg" width="120" alt="NestJS Logo" /></a>
</p>

<p align="center">Auto-instrumented observability for <a href="https://nestjs.com" target="_blank">NestJS</a> applications — traces, errors, logs, jobs and runtime metrics, with no manual span wiring.</p>

<p align="center">
<a href="https://www.npmjs.com/package/@nestjs/observe"><img src="https://img.shields.io/npm/v/@nestjs/observe.svg" alt="NPM Version" /></a>
<a href="https://www.npmjs.com/package/@nestjs/observe"><img src="https://img.shields.io/npm/dm/@nestjs/observe.svg" alt="NPM Downloads" /></a>
<a href="https://www.npmjs.com/package/@nestjs/observe"><img src="https://img.shields.io/npm/l/@nestjs/observe.svg" alt="Package License" /></a>
</p>

<p align="center">
  <a href="https://www.observe-demo.nestjs.com/dashboard"><b>Live demo</b></a> ·
  <a href="https://observe.nestjs.com"><b>Website</b></a> ·
  <a href="https://docs.nestjs.com">Documentation</a>
</p>

## What it is

`@nestjs/observe` instruments a NestJS application from the inside. It hooks
into Nest's own request lifecycle — controllers, interceptors, guards, queue
consumers, resolvers — rather than wrapping a generic Node.js agent around the
framework, so a trace is named in the vocabulary you wrote the code in: classes
and methods, not just HTTP routes.

Install it, set two environment variables, and the application starts reporting:

- **Requests, jobs and RPC calls** — HTTP, GraphQL, microservices (RPC/gRPC),
  BullMQ (and BullMQ Pro) consumers and `@nestjs/schedule` cron, interval and
  timeout jobs.
- **Distributed traces** with per-span self time, correlated across services.
- **Errors**, grouped by fingerprint, with the source frame and the trace that
  produced them.
- **Logs**, correlated to the request that wrote them, once `forwardLogs` is
  on.
- **Runtime metrics**, and the
  [custom metrics](https://www.observe.nestjs.com/documentation/sdk#custom-metrics)
  your code reports through `TracerService`.

Telemetry is serialised on a detached worker thread and shipped from there, so
the request path is untouched by the reporting.

### Why not just OpenTelemetry?

OpenTelemetry is the right answer when you need vendor neutrality across a
polyglot estate, and this agent is not a replacement for it. It is a different
trade: no collector to run, no exporter pipeline to configure, no manual
instrumentation for the framework's own lifecycle — and spans named after your
Nest classes and methods, which generic Node.js instrumentation cannot produce
because it cannot see them. If you would otherwise spend a week wiring a
collector and still not know which provider spent the time, this is the
shortcut.

## Seeing it before installing

**[observe-demo.nestjs.com](https://www.observe-demo.nestjs.com/dashboard)** is the whole
dashboard running over a generated dataset from a busy service — real request
volumes, traces with waterfalls, errors, jobs and alerts. No signup, nothing to
install.

```bash
$ npm install @nestjs/observe
```

## Getting credentials

Sign up at **[observe.nestjs.com](https://observe.nestjs.com)** and create a
service. The dashboard issues an **app key** and an **app secret**, which the
agent sends on every ingest request.

**Free for up to 300,000 events a month**, which covers most individual projects, startups, and small applications.

The secret is shown once and is not retrievable afterwards - store it with the
rest of your secrets and supply both from the environment:

```bash
OBSERVE_APP_KEY=...
OBSERVE_APP_SECRET=...
```

Without valid credentials the collector answers `401` and telemetry is dropped.
The agent says so once, then backs off - one flush interval, then two, then
four, up to one attempt an hour - until the credentials are fixed. They are
read at startup, so that takes a restart. Leave `appKey` or `appSecret` unset
and nothing is sent to the hosted collector at all, with a warning at startup
instead; a collector of your own at `endpoint` still receives batches without
them.

## Quick start

`createObserveModule()` returns both the dynamic module and the instrumentation
hook Nest needs at bootstrap:

```ts
// observe.ts
import { createObserveModule } from "@nestjs/observe";

export const { ObserveModule, ObserveInstrument } = createObserveModule();
```

```ts
// app.module.ts
import { Module } from "@nestjs/common";
import { ObserveModule } from "./observe";

@Module({
  imports: [
    ObserveModule.forRoot({
      appKey: process.env.OBSERVE_APP_KEY!,
      appSecret: process.env.OBSERVE_APP_SECRET!,
      serviceId: "my-service",
    }),
  ],
})
export class AppModule {}
```

```ts
// main.ts
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { ObserveInstrument } from "./observe";

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    instrument: ObserveInstrument,
  });
  app.enableShutdownHooks();
  await app.listen(3000);
}
bootstrap();
```

`enableShutdownHooks()` is what lets the agent send what it still holds when the process is stopped - a deploy, a scale-in. Without it Nest runs no shutdown hooks on `SIGTERM`, and the last few seconds of telemetry, the last requests' errors among them, are lost. For the same reason, import `ObserveModule` before other global modules such as `BullModule`: global modules shut down in reverse order of import, and jobs that finish after the agent has stopped are not sent.

### Async configuration

`ObserveModule.forRootAsync()` resolves the options from the DI container, via
`useFactory`, `useClass`, or `useExisting`:

```ts
ObserveModule.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    appKey: config.getOrThrow("OBSERVE_APP_KEY"),
    appSecret: config.getOrThrow("OBSERVE_APP_SECRET"),
    serviceId: config.getOrThrow("OBSERVE_SERVICE_ID"),
  }),
});
```

`useClass` and `useExisting` take a class implementing `ObserveOptionsFactory`:

```ts
@Injectable()
export class ObserveConfig implements ObserveOptionsFactory {
  createObserveOptions(): ObserveOptions {
    return { appKey: "...", appSecret: "...", serviceId: "..." };
  }
}
```

## Repeated spans

Every provider is instrumented by default, framework-owned ones included, and
some of them run in loops the application never wrote. A `ValidationPipe`
registered through `APP_PIPE` runs once per argument of every GraphQL field
resolver, so a single list query produces hundreds or thousands of identical
sibling spans under the operation - each of them a metered event, and together
saying nothing a count would not.

The agent collapses those before a trace leaves the process. When more than
`threshold` siblings under one parent share a class and method:

- the slowest `keepSlowest` of them stay as ordinary spans,
- any instance that errored stays as an ordinary span, whatever its duration,
- the rest are replaced by one node that carries how many calls it stands for
  and the **sum** of their durations.

Nothing is skipped outright and no duration cut-off is involved: what
validation costs is specific to each application, and the calls that explain a
slow request are exactly the ones kept whole. The collapsed node is metered as
a single event.

```ts
ObserveModule.forRoot({
  // ...
  spanCollapse: { threshold: 20, keepSlowest: 3 }, // the defaults
  // spanCollapse: false, // ship every span
});
```

What a collapsed node means:

- Its `observe.collapsed` tag is the number of calls it replaces, and its name
  reads `ValidationPipe.transform ×27` so a waterfall shows an aggregate rather
  than one more call.
- `duration` is the sum of the replaced calls' durations, not the wall-clock
  span between the first and the last. That is what keeps the parent's self
  time - its duration minus its children's - exactly what it was.
- `startOffset` is the earliest replaced call's, and the node sits where that
  call sat among its siblings. Ordering _among_ the replaced calls is lost,
  which is acceptable for calls that are identical by construction.
- The replaced calls' own children are carried onto the node, so the time of
  whatever they called is still attributed to the class that spent it; a
  repeated frame beneath them collapses in turn.
- Tags of the replaced calls are dropped. Manual spans are never collapsed.

The wire format is unchanged: the count travels inside `t` (tags), next to `n`
name, `o` origin, `d` duration, `e` error, `c` className, `m` methodKey, `ch`
children, `s` spanId and `so` startOffset. A collector that does not know the
tag stores it like any other and attributes the node as one call of its class
rather than as the number it carries.

## Skipping spans for expected outcomes

Nest applications answer "not found", "not allowed" and "invalid input" by
throwing - `NotFoundException`, `ForbiddenException`, a `ValidationPipe`'s
`BadRequestException` - and every one of those requests ships the full tree of
calls it made, each span a metered event. `skipSpans` reports such requests
without their spans:

```ts
ObserveModule.forRoot({
  // ...
  skipSpans: [400, 401, 403, 404],
  // or decide per operation:
  // skipSpans: ({ statusCode, duration }) => statusCode === 404 && duration < 1000,
});
```

What stays and what goes:

- The request is still reported - route, status code, duration, user - so it
  counts in every chart as before.
- Its error is still reported, stack included, so it appears on the Errors page
  exactly as it did.
- The span tree underneath it is dropped before anything is serialized or
  sent: the waterfall shows the request with nothing inside it, and its calls
  are missing from the per-method numbers. A skipped request costs its own
  event, plus its error's when it failed with one, and nothing more.

The status code is the one the request is reported with. Microservice, gRPC and
WebSocket handlers have no status of their own; they get one when they throw -
a Nest exception's own 4xx, or 500 - so `[404]` covers a message handler that
threw `NotFoundException` too. Jobs always keep their spans. The function form
is told `protocol`, `operationId`, `method`, `statusCode`, `duration` and
`errorClass`; if it throws, the spans are kept and the failure is logged once.

## What it records without any code

Once the module and the instrument are in place, the agent reports, with no further changes to your application:

- **Requests, GraphQL operations, RPC messages, WebSocket gateway messages, queue jobs and scheduled jobs**, each with its tree of provider method calls.
- **Database queries**, as a span under the method that ran them, for `pg`, `mysql2` and `mongodb`. Anything built on those drivers is covered without being known by name: TypeORM, Drizzle, MikroORM and Mongoose are tested in this repository, and others (Knex, Sequelize) go through the same driver calls. The statement is recorded with every value removed (`SELECT "o"."id" FROM "orders" "o" WHERE "o"."customer_id" = $1`). Prisma's Rust query engine does not go through these drivers and is not covered yet.
- **Outbound HTTP calls** made with `fetch`/`undici` or `node:http`/`https` (so Axios too), as `POST api.stripe.com`. The current trace id is forwarded as `x-request-id` - by `fetch` on every supported Node version, by `node:http`/`https` from Node 22.12, the first to let a request's headers still be set at that point - so a service that also runs the agent continues the same trace; a header you set yourself is never overwritten.
- **Trace ids across queues**: a BullMQ (Pro included) or Bull job enqueued while handling a request carries that request's trace id, so the request and its job show up as one trace. Repeatable (cron) jobs start their own.
- **The code around an error's throw site**: for each in-app frame of a captured error, a few lines of source either side, read from the running process, so the dashboard shows the failing code next to the stack. This sends fragments of your application's source to Observe, stored with the error. Frames in `node_modules` and Node internals are never read. `createObserveModule({ sourceContext: false })` turns it off; the [documentation](https://www.observe.nestjs.com/documentation/sdk#error-source-context) covers tuning it instead.
- **The release it is running**, so Releases, regressions and fix verification work without a version threaded through the build: `OBSERVE_SERVICE_VERSION` if the environment sets it, else the commit a platform or CI job exposes (Vercel, Render, Railway, Heroku, GitHub Actions, GitLab CI and others), else the commit checked out where the process runs, else a Cloud Run or Azure Container Apps revision. A container image usually carries none of these, so hand it the commit at build time - `ARG GIT_SHA` then `ENV OBSERVE_SERVICE_VERSION=$GIT_SHA`. `serviceVersion` names the release yourself, in at most 50 characters - a longer one is cut to fit, with a warning at startup; `serviceVersion: false` reports none.

Query and outbound-HTTP spans are not billed as events. Turn them off with `outgoing: false`, or one side with `outgoing: { database: false }` / `outgoing: { http: false }`.

## Capturing failed and slow requests

The inputs behind a failing request are usually the fastest way to reproduce it. The agent keeps them only for the requests worth it - never for ordinary traffic:

```ts
ObserveModule.forRoot({
  // ...
  http: {
    capture: {
      // Also capture requests that took at least this long, failed or not.
      slowerThanMs: 2000,
      // Off by default: a body is your users' data. Capped at 2 KB unless
      // you pass `{ maxBytes }` (at most 16 KB).
      body: true,
      // Defaults to a short list with nothing that authenticates or
      // identifies anyone: accept, content-type, user-agent, ...
      // Pass your own list, or `false` for none.
      headers: ["content-type", "user-agent", "x-tenant-id"],
    },
  },
});
```

A failed request is always captured (headers only, unless `body` is on); `capture: false` turns the feature off. Everything captured goes through the same redaction as error messages and logs before it leaves the process - sensitive keys by name, secrets by pattern - so naming `authorization` in `headers` records `[REDACTED]`.

## Custom request operation IDs

HTTP requests are grouped by their route path by default. If you want to report
a different operation name for a request, inject `TracerService` and call
`setOperationId()` from the handler:

```ts
import { TracerService } from "@nestjs/observe";

// Inject TracerService in your controller's constructor:
constructor(private readonly tracerService: TracerService) {}

// Choose any naming scheme that suits your application:
this.tracerService.setOperationId(`/rpc/${body.method}`);
```

For example, an RPC handler could distinguish `orders.list` from `orders.create`,
even when both requests use the same route. This changes only the operation ID,
not the URL, HTTP method, tags, or spans. A value set in the handler overrides
the route or GraphQL name; subsequent calls replace it.

The operation ID is an application-defined name; choose any scheme that fits
your use case. Use stable, bounded names rather than per-request values such as
user IDs or request IDs to avoid high-cardinality groups. The method is a no-op
outside an active trace and for ignored or sampled-out requests.

## Declaring objectives in code

`@Objective()` states what a route promises, next to the handler that has to keep it, and Observe turns each promise into an [SLO](https://www.observe.nestjs.com/documentation/slos). The objective is written, reviewed and versioned with the route it covers:

```ts
import { Objective } from "@nestjs/observe";

@Controller("orders")
export class OrdersController {
  @Post()
  @Objective({ availability: 99.9, latency: { underMs: 300, target: 99 } })
  create(@Body() dto: CreateOrderDto) {
    return this.ordersService.create(dto);
  }
}
```

- `availability` - the percentage of requests that don't fail with an unhandled error: `99.9` for three nines.
- `latency` - `{ underMs, target }`: `target` percent of requests finish in under `underMs` milliseconds.
- `windowDays` - the rolling window it is judged over: 7, 14, 28 (the default) or 30 days.
- `name` - what the dashboard calls it, instead of the route and the promise.

Each promise becomes its own SLO, scoped to the application and the route: `POST /orders availability` and `POST /orders under 300ms` above. The route is read from the first request the handler serves, so a global prefix, URI versioning and `RouterModule` paths come out right, and the SLO appears once the route has had traffic. From then on:

- **The code owns it.** Change a target, a window or a name and deploy, and the same SLO follows. The dashboard marks it **in code**, names the handler and the release that last declared it, and doesn't edit it. A new latency threshold is a new promise, so it becomes a new SLO.
- **A delete in the dashboard doesn't last** while the decorator is there: the agent restates each route's objectives hourly, and a missing SLO is made again. To retire one, remove the decorator, then delete the SLO.

Declarations are checked when the application starts, and whatever fails is logged rather than sent. Targets run from 90 to 99.999, `underMs` is whole milliseconds up to 600000, and a handler carries at most ten objectives; a field other than these four is left out. A handler mounted on several routes - `@Get(["catalog", "products"])`, or a controller answering two versions - isn't declared at all, because an SLO watches one route: give each route a handler of its own.

SLOs need a plan that has them - Scale or Enterprise. On any other plan, declarations are sent and ignored. The [documentation](https://www.observe.nestjs.com/documentation/sdk#declaring-objectives-in-code) has the rest.

## Configuration

Every option, with its default. The [documentation](https://www.observe.nestjs.com/documentation/sdk) covers each in more depth.

`ObserveModule.forRoot()`, and the factory behind `forRootAsync()`, take:

| Option                   | Default                             | What it does                                                                                                                                                                                      |
| ------------------------ | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `appKey`, `appSecret`    | required                            | The credentials the dashboard issues - see [Getting credentials](#getting-credentials).                                                                                                           |
| `serviceId`              | required                            | Names the service in the dashboard, in at most 100 characters - a longer one is cut to fit, with a warning at startup.                                                                           |
| `serviceVersion`         | inferred                            | The release the process runs, at most 50 characters - see [What it records without any code](#what-it-records-without-any-code). `false` reports none.                                          |
| `endpoint`               | `https://observe-api.nestjs.com`    | The collector's base URL. `OBSERVE_ENDPOINT` in the environment changes the default without touching the config.                                                                                  |
| `flushInterval`          | `5000`                              | Milliseconds between sends of buffered telemetry; at least `1000`.                                                                                                                                |
| `shutdownFlushTimeout`   | `2000`                              | Milliseconds closing the app waits for buffered telemetry to reach the collector before stopping the agent. `0` skips the final send - for test suites that boot the app with real credentials.   |
| `maxTracesPerBatch`      | `1000`                              | The most traces one send carries.                                                                                                                                                                 |
| `tracesSampleRate`       | `1.0`                               | The share of traces kept, or a function `(protocol, attributes) => boolean` deciding per trace. `0` counts as unset and keeps every trace; `() => false` keeps none.                              |
| `spanCollapse`           | `{ threshold: 20, keepSlowest: 3 }` | See [Repeated spans](#repeated-spans). `false` ships every span.                                                                                                                                  |
| `skipSpans`              | none                                | See [Skipping spans for expected outcomes](#skipping-spans-for-expected-outcomes).                                                                                                                |
| `runtimeMetrics`         | `true`                              | Samples memory, CPU, garbage collection and the event loop for the dashboard's [Profiler](https://www.observe.nestjs.com/documentation/profiler).                                                 |
| `runtimeMetricsInterval` | `60000`                             | Milliseconds between runtime samples; at least `30000`.                                                                                                                                           |
| `forwardLogs`            | `false`                             | Sends the application's log lines, each correlated to the trace it was written in - see [Logs](https://www.observe.nestjs.com/documentation/sdk#logs).                                           |
| `redaction`              | on                                  | How log lines, error messages and captured requests are scrubbed before they leave the process: `enabled`, `useDefaultPatterns`, `patterns`, `keys` and `replacement`.                           |
| `outgoing`               | on                                  | Query and outbound-HTTP spans. `false` turns both off; `{ database: false }` or `{ http: false }` one of them.                                                                                    |
| `http`                   |                                     | `ignore`, `tags`, `setAttributes`, `getUserId`, `queryParamsObfuscateRegex`, `tracePreflights` and `capture` - see [Capturing failed and slow requests](#capturing-failed-and-slow-requests).    |
| `rpc`, `grpc`            |                                     | `ignore`, `tags`, `setAttributes` and `getUserId` for microservice and gRPC handlers.                                                                                                             |
| `graphql`                |                                     | The same four, once per GraphQL operation.                                                                                                                                                        |
| `ws`                     |                                     | The same four, once per gateway message.                                                                                                                                                          |
| `jobs`                   |                                     | `ignore`, `tags` and `setAttributes` for queue jobs and scheduled handlers.                                                                                                                       |
| `debug`                  | `false`                             | Logs the SDK's own diagnostics.                                                                                                                                                                   |

`forRootAsync()` also takes `extraProviders`, and `global`, which defaults to `true` - `forRoot()` always registers the module globally.

`createObserveModule()` takes the options the instrumentation needs before any module exists:

| Option                | Default                                  | What it does                                                                                                                                                                                         |
| --------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sourceContext`       | `true`                                   | Attaches the source around each in-app frame of a captured error - see [What it records without any code](#what-it-records-without-any-code). `{ linesOfContext, maxFrames, sourceMaps }` tunes it. |
| `traceIdGenerator`    | the `x-request-id` header, else a UUIDv7 | Gives each request its trace id.                                                                                                                                                                     |
| `traceIdKey`          | `'traceId'`                              | The key the trace id is stored under in the request context.                                                                                                                                         |
| `attachTraceIdToLogs` | `true`                                   | Adds the trace id to the `ConsoleLogger`'s own output, on Nest 11.2 and later. Sending lines to the dashboard is `forwardLogs`.                                                                       |
| `skipInstrumentation` | `() => false`                            | Returns `true` for a provider instance that must not be instrumented. Nest's `Reflector` never is, whatever this returns.                                                                            |

## Optional peer dependencies

Protocol integrations are only loaded when you use them, and their packages are optional peers:

- `@nestjs/microservices` - RPC/microservice instrumentation
- `@nestjs/graphql` - GraphQL operation instrumentation
- `@nestjs/bullmq` and `bullmq` - queue/job instrumentation
- `@taskforcesh/bullmq-pro` - the same, for BullMQ Pro, whether it is wired in through `@taskforcesh/nestjs-bullmq-pro` or through `@nestjs/bullmq` (`BullModule.workerClass = WorkerPro`)
- `@nestjs/bull` and `bull` - the same, for legacy Bull
- `@nestjs/websockets` - WebSocket gateway instrumentation (`ws` and socket.io adapters)
- `@nestjs/schedule` - scheduled job (`@Cron`, `@Interval`, `@Timeout`) instrumentation

## Test

```bash
# the lockfile is written with legacy-peer-deps on, and has to be read that way
$ npm ci --legacy-peer-deps

# unit tests
$ npm test

# type-check the sources and the specs
$ npm run typecheck

# integration tests (boot real Nest apps on real ports)
$ npm run test:int
```

The queue suites need a Redis, and the query-span suites a PostgreSQL, MySQL and MongoDB. Each suite skips itself when its server does not answer, so without them `test:int` passes having tested less. CI starts them with these ports and credentials, which the suites default to:

```bash
$ docker run -d -p 6379:6379 redis:7-alpine
$ docker run -d -p 54321:5432 -e POSTGRES_PASSWORD=postgres-whisprr postgres:16-alpine
$ docker run -d -p 3306:3306 -e MYSQL_ROOT_PASSWORD=root -e MYSQL_DATABASE=test mysql:8
$ docker run -d -p 27027:27017 mongo:8
```

To point them elsewhere, set `REDIS_HOST`/`REDIS_PORT`, `PGHOST`/`PGPORT`/`PGUSER`/`PGPASSWORD`/`PGDATABASE`, `MYSQL_HOST`/`MYSQL_PORT`/`MYSQL_USER`/`MYSQL_PASSWORD`/`MYSQL_DATABASE` or `MONGO_HOST`/`MONGO_PORT`.

## Module format

The package ships as ESM only. CommonJS consumers can still `require()` it
through Node's `require(esm)` support, which is why the engine floor is
**Node 20.19** (or 22.12) rather than 20.0 - and why nothing in the module graph
uses top-level await, which `require(esm)` cannot load.

```js
// works from CommonJS on Node >= 20.19
const { createObserveModule } = require("@nestjs/observe");
```

## Stay in touch

- Dashboard — [observe.nestjs.com](https://observe.nestjs.com)
- Live demo — [observe-demo.nestjs.com](https://www.observe-demo.nestjs.com/dashboard)
- Documentation — [docs.nestjs.com](https://docs.nestjs.com)
- Twitter — [@nestframework](https://twitter.com/nestframework)

## License

`@nestjs/observe` is [MIT licensed](LICENSE).
