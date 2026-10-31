<p align="center">
  <a href="https://observe.nestjs.com" target="_blank"><img src="https://nestjs.com/img/logo-small.svg" width="120" alt="NestJS Logo" /></a>
</p>

<p align="center">Auto-instrumented observability for <a href="https://nestjs.com" target="_blank">NestJS</a> applications — traces, errors, logs, jobs and runtime metrics, with no manual span wiring.</p>

<p align="center">
<a href="https://www.npmjs.com/package/@nestjs/observe"><img src="https://img.shields.io/npm/v/@nestjs/observe.svg" alt="NPM Version" /></a>
<a href="https://www.npmjs.com/package/@nestjs/observe"><img src="https://img.shields.io/npm/dm/@nestjs/observe.svg" alt="NPM Downloads" /></a>
<a href="LICENSE"><img src="https://img.shields.io/badge/license-Observe%20Agent-blue.svg" alt="License: NestJS Observe Agent License" /></a>
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

Telemetry is compressed and sent from a detached worker thread, so a slow or
unreachable collector never holds a request up. Recording it does cost the
request path a microsecond or two per traced call - [Overhead](#overhead) has
the numbers.

### Why not just OpenTelemetry?

OpenTelemetry is the right answer when you need vendor neutrality across a
polyglot estate, and this agent is not a replacement for it. It is a different
trade: no collector to run, no exporter pipeline to configure, no manual
instrumentation for the framework's own lifecycle — and spans named after your
Nest classes and methods, which generic Node.js instrumentation cannot produce
because it cannot see them. If you would otherwise spend a week wiring a
collector and still not know which provider spent the time, this is the
shortcut.

It also runs beside OpenTelemetry, with `openTelemetry: true`. The agent then
continues and sends W3C `traceparent`, so a trace that runs through services
instrumented with OpenTelemetry stays one trace. In a Nest service that already
starts the OpenTelemetry Node SDK, it reports each request under the trace id
the SDK gave it - also when the request started the trace - and leaves
`traceparent` to the SDK on calls out of the service, so a request has one
trace id in both tools and every call carries one `traceparent`. The SDK keeps
its own spans, the agent adds the class-level ones. This is tested against the
SDK with its auto-instrumentations, on Express and Fastify, over `fetch`,
`node:http`, `pg` and Nest's own instrumentation. Without the option, the agent
speaks `x-request-id` alone and leaves any OpenTelemetry SDK in the process
alone.

It works only beside reporting to NestJS Observe. It turns on with the first
batch the collector accepts, and pauses - saying so in the log - while the
collector refuses the app's credentials, once batches have failed to get in
for a minute, or while the agent's worker is down, resuming with the next batch
the collector accepts. With `enabled: false`, or without credentials for the
hosted collector, it never turns on.

```typescript
ObserveModule.forRoot({
  serviceId: "orders-api",
  openTelemetry: true,
});
```

## Seeing it before installing

**[observe-demo.nestjs.com](https://www.observe-demo.nestjs.com/dashboard)** is the whole
dashboard running over a generated dataset from a busy service — real request
volumes, traces with waterfalls, errors, jobs and alerts. No signup, nothing to
install.

```bash
$ npm install @nestjs/observe
```

## Getting credentials

The quickest way is from the project's directory:

```bash
$ npx @nestjs/observe link
```

It prints a code, you type it at
**[observe.nestjs.com/link](https://observe.nestjs.com/link)** (signing up
first if you have no account) and approve, and it writes the key pair into
`.env` as `OBSERVE_APP_KEY` and `OBSERVE_APP_SECRET`, git-ignores `.env`, and
adds `--env-file .env` to every script that runs `nest start` (`start`,
`start:dev` and `start:debug` in a `nest new` project). `ObserveModule` reads those two variables whenever `appKey` and
`appSecret` are left out or still hold the `nest new` placeholders.

In an app that does not use the SDK yet, the same command also installs
`@nestjs/observe` with the project's package manager and wires it in -
`ObserveModule.forRoot()` first in the root module's imports, `ObserveInstrument`
passed to `NestFactory.create()` - so the app reports from its next start. It
says so before you approve, and leaves a workspace with several applications
for you to wire by hand, as the [Quick start](#quick-start) shows.

Or sign up at **[observe.nestjs.com](https://observe.nestjs.com)** and create a
service by hand. The dashboard issues an **app key** and an **app secret**,
which the agent sends on every ingest request.

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
read at startup, so that takes a restart. Leave `appKey` or `appSecret` unset,
with nothing in `OBSERVE_APP_KEY` or `OBSERVE_APP_SECRET` either, and nothing
is sent to the hosted collector at all, with a warning at startup instead; a proxy at `endpoint` that adds them on the way to NestJS Observe still
receives batches without them.

To keep an environment from reporting - local development, say - switch the
agent off rather than supplying fake credentials, which are sent and refused:

```ts
ObserveModule.forRoot({
  enabled: process.env.NODE_ENV === "production",
  serviceId: "my-service",
});
```

With `enabled: false` the module stays imported - `TracerService` still
resolves, and calling it is harmless - but nothing is recorded or sent, and the
only trace of it is one line at startup.

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
    // appKey and appSecret default to OBSERVE_APP_KEY and OBSERVE_APP_SECRET.
    ObserveModule.forRoot({ serviceId: "my-service" }),
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

## Overhead

What the agent costs an application is mostly the spans it records: every
provider method a request calls passes through the instrumentation, on the
thread serving the request. Measured in October 2026 with
[the benchmark in `bench/`](https://github.com/nestjs/observe/blob/master/bench/README.md),
the agent at its defaults against the same Nest 12 application without it, on
Express, Node 24 and an Apple M1 Pro:

| Per request                            | 1 traced call | 9 traced calls | 102 traced calls |
| -------------------------------------- | ------------- | -------------- | ---------------- |
| CPU added, process fully busy          | +9 µs         | +29 µs         | +115 µs          |
| Median latency added at 150 requests/s | +0.10 ms      | +0.09 ms       | +0.45 ms         |

The nine calls are a guard, an interceptor, a pipe, a controller, a service and
two repositories awaiting their results; the 102 are a service calling another
provider in a loop, [collapsed](#repeated-spans) to six spans before shipping.

| Per process                | Added                                                |
| -------------------------- | ---------------------------------------------------- |
| Memory at boot             | +11 MB RSS                                           |
| Memory at 150 requests/s   | +32 MB to +64 MB RSS                                 |
| CPU while idle             | 0.3-0.6% of one core, almost all off the main thread |
| Process start to listening | +30 to +40 ms, within run-to-run noise               |

As a rule of thumb, **about 8 µs per request plus 1-2.5 µs per traced call**,
async methods at the dearer end. A traced provider reads its own fields -
`this.repository`, `this.config.rate` - through a proxy, at about 30 ns a read,
which a loop over thousands of items pays on every iteration.

Spans are recorded on the thread that serves the request. Every
`flushInterval` (5 s) that thread serialises the batch, and a worker thread
compresses and sends it. A batch holds at most `maxTracesPerBatch` traces
(1,000), which also caps what shipping costs: requests past it within a flush
interval are recorded but not sent. A lightly loaded process pays more CPU per
request than a busy one, with the agent or without, and the agent's share
grows with it: at 150 requests a second it added 3.5 to 4 points of one core on
the 1- and 9-call endpoints, and 10 on the 102-call one.

These endpoints do almost no work of their own, so in relative terms the
figures are a ceiling: an endpoint that spends a millisecond on a query pays
the same microseconds. They were taken on a development machine with other
work running, as medians of two runs, and moved by a third between runs - by
half for a lightly loaded process. The run behind them is in
[`bench/2026-10-30-results.md`](https://github.com/nestjs/observe/blob/master/bench/2026-10-30-results.md),
and `npm run bench` in a clone of this repository reproduces it on your own
hardware in about 8 minutes.

### Compared with other agents

We found no overhead figures published by the vendors below, so the table
takes third-party benchmarks, each measuring an agent on a near-empty endpoint
on its own hardware. It says which way things lean rather than ranking them:

| Agent                                       | Benchmark                                      | Throughput lost | Time added per request |
| ------------------------------------------- | ---------------------------------------------- | --------------- | ---------------------- |
| New Relic                                   | [NodeSource][nodesource], Express, Node 22     | 72%             | 200 µs                 |
| Datadog                                     | [NodeSource][nodesource], Express, Node 22     | 63%             | 130 µs                 |
| Sentry                                      | [NodeSource][nodesource], Express, Node 22     | 37%             | 45 µs                  |
| OpenTelemetry, all auto-instrumentations    | [Platformatic][platformatic], Fastify, Node 24 | 81%             | 77 µs                  |
| OpenTelemetry, Fastify instrumentation only | [Platformatic][platformatic], Fastify, Node 24 | 64%             | 31 µs                  |
| `@nestjs/observe`, 1 traced call            | this benchmark, Nest on Express, Node 24       | 22%             | 7 µs                   |
| `@nestjs/observe`, 9 traced calls           | this benchmark, Nest on Express, Node 24       | 33%             | 20 µs                  |
| `@nestjs/observe`, 102 traced calls         | this benchmark, Nest on Express, Node 24       | 69%             | 110 µs                 |

Time added per request is what a fully busy process spends on each request with
the agent, minus without it - one second divided by the requests per second,
from each benchmark's own figures. It is the time of the thread that serves
requests, so it reads a little under the CPU added above, which counts every
thread of the process. Neither column ranks the agents. The machines differ:
NodeSource's run (July 2025) is on a 4-core 3.6 GHz Linux server where plain
Express answers 13,000 requests a second, so the same work takes longer there
than on this laptop, where the Nest application answers 20,000 to 38,000. And a
percentage depends on how fast the baseline is: the same microseconds are a
bigger share of a faster one.

What neither column shows is how much gets recorded. The agents above trace a
request, its middleware and its calls out of the process, and OpenTelemetry's
full set more kinds of call than its Fastify instrumentation alone - DNS
lookups and sockets among them. This one also traces every provider method the
request goes through: the class-level waterfall, and the reason an endpoint
making a hundred provider calls costs it more than it would them.

[nodesource]: https://benchmark.nodesource.com/
[platformatic]: https://blog.platformatic.dev/the-hidden-cost-of-context

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
- **Database queries**, as a span under the method that ran them, for `pg`, `mysql2`, `mssql` and `mongodb`. Anything built on those drivers is covered without being known by name: TypeORM, Drizzle, MikroORM and Mongoose are tested in this repository, and others (Knex, Sequelize) go through the same driver calls. SQL Server is the exception: `mssql` is what TypeORM and Prisma's SQL Server adapter run on, but Knex, Sequelize and MikroORM talk to SQL Server through `tedious` directly, which is not covered yet (nor is `mssql/msnodesqlv8`). The statement is recorded with every value removed (`SELECT "o"."id" FROM "orders" "o" WHERE "o"."customer_id" = $1`). Prisma's Rust query engine does not go through these drivers and is not covered yet.
- **Outbound HTTP calls** made with `fetch`/`undici` or `node:http`/`https` (so Axios too), as `POST api.stripe.com`. The current trace id is forwarded as `x-request-id` - by `fetch` on every supported Node version, by `node:http`/`https` from Node 22.12, the first to let a request's headers still be set at that point - so a service that also runs the agent continues the same trace; a header you set yourself is never overwritten. With `openTelemetry: true`, a W3C `traceparent` goes with it, naming the trace and the call's span, so a service instrumented with OpenTelemetry - in Go, Python, Java or anything else - continues it too, as does a service running the agent behind it. When an OpenTelemetry SDK that propagates W3C Trace Context runs in the same process, `traceparent` is left to it: its instrumentations write the header on the calls they cover, and a request takes only one. `outgoing: { http: { traceContext: false } }` sends `x-request-id` alone even then, and `propagateTraceId: (url) => boolean` keeps both headers away from the URLs you name.
- **Trace context from OpenTelemetry**, with `openTelemetry: true`: a request arriving with a W3C `traceparent` - from a service instrumented with OpenTelemetry, a mesh, or a load balancer that starts traces - is reported under that trace id, written as a UUID (`4bf92f35-77b3-4da6-a3ce-929d0e0e4736`), so the same id finds it in both tools. With an OpenTelemetry SDK in the same process - or one built on it, as Sentry's Node SDK is from version 8 - the trace is the one the SDK's server span is in, so a request that starts a trace gets the SDK's id too. That holds when a mesh or router stamped an `x-request-id` of its own on the request too, as Envoy and Heroku's router do: an `x-request-id` is kept only when it names the same trace, which is what another service running the agent sends, so custom ids still carry from one such service to the next. Over HTTP only: microservice, gRPC and queue hops pass the trace id as `x-request-id` and job options, as before. Without the option, a request is named by its `x-request-id`, else by a UUIDv7 of its own, and no `traceparent` is read or sent.
- **Model calls**: a `fetch` to OpenAI, Azure OpenAI, Anthropic, Gemini or Vertex, Bedrock, Mistral, Groq, OpenRouter, Together, DeepSeek, xAI, Cohere or Perplexity also reports the model and the input, output and cached tokens its response states - read as the response passes through to your code, streams included, so it arrives exactly as it would have and a stream you cancel is cancelled at the provider too. That covers the official SDKs, the Vercel AI SDK and LangChain, which all use `fetch`; calls made through `node:http` (axios, the AWS SDK) keep their plain span. Prompts and completions are never reported. A gateway in front of the providers is added with `outgoing: { llm: { hosts: ['llm-gateway.internal:4000'] } }`, and `outgoing: { llm: false }` turns this off and leaves the global `fetch` as it was.
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
`setOperationId()` while the request is in flight - from the handler, or from a
guard, interceptor or middleware:

```ts
import { TracerService } from "@nestjs/observe";

// Inject TracerService in your controller's constructor:
constructor(private readonly tracerService: TracerService) {}

// Choose any naming scheme that suits your application. `body.method` comes
// from the client, so name only the methods you serve:
const RPC_METHODS = new Set(["orders.list", "orders.create", "customers.get"]);

this.tracerService.setOperationId(
  RPC_METHODS.has(body.method) ? `/rpc/${body.method}` : "/rpc/unknown",
);
```

For example, an RPC handler could distinguish `orders.list` from `orders.create`,
even when both requests use the same route. This changes only the operation ID,
not the URL, HTTP method, tags, or spans. The name replaces the route or GraphQL
name; a later call replaces an earlier one.

The operation ID is an application-defined name; choose any scheme that fits
your use case. Use stable, bounded names rather than per-request values such as
user IDs or request IDs to avoid high-cardinality groups, and don't pass a
client-supplied value through unchecked: that lets any caller create new groups.
Names are trimmed and cut to 255 characters, and anything other than a non-blank
string is ignored. The method is a no-op outside an active trace and for ignored
or sampled-out requests.

Observe keeps up to 100 custom names per project in any 30 days. A request
renamed to a name past that is reported under the route it replaced, and a name
gives its place up once no request has used it for 30 days.

Everything keyed on the operation ID sees the new name: a drop filter on
`http.route` (one on `http.url` still matches the URL),
[`skipSpans`](#skipping-spans-for-expected-outcomes), alerts and SLOs. Rules
and history recorded under the old name don't carry over to the new one.
`@Objective()` is not declared for renamed requests: an SLO watches one route,
and each name is a route of its own.

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
| `enabled`                | `true`                              | `false` records and sends nothing, and needs no credentials - see [Getting credentials](#getting-credentials).                                                                                    |
| `appKey`, `appSecret`    | required                            | The credentials the dashboard issues - see [Getting credentials](#getting-credentials).                                                                                                           |
| `serviceId`              | required                            | Names the service in the dashboard, in at most 100 characters - a longer one is cut to fit, with a warning at startup.                                                                           |
| `serviceVersion`         | inferred                            | The release the process runs, at most 50 characters - see [What it records without any code](#what-it-records-without-any-code). `false` reports none.                                          |
| `endpoint`               | `https://observe-api.nestjs.com`    | The collector's base URL - NestJS Observe, or a proxy that forwards to it. `OBSERVE_ENDPOINT` in the environment changes the default without touching the config.                                                                                  |
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
| `outgoing`               | on                                  | Query and outbound-HTTP spans. `false` turns both off; `{ database: false }` or `{ http: false }` one of them. `{ http: { propagateTraceId, traceContext } }` tunes the `x-request-id` and `traceparent` headers outbound calls carry - `traceparent` only with `openTelemetry`. |
| `openTelemetry`          | `false`                             | Continues and sends W3C `traceparent`, names a request after the W3C trace it is in, and follows an OpenTelemetry SDK running in the same process - see [Why not just OpenTelemetry?](#why-not-just-opentelemetry). Works only while the agent is reporting to NestJS Observe. Off, the agent reads and sends `x-request-id` alone. |
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
| `traceIdGenerator`    | the `x-request-id` header, else a UUIDv7 | Gives each request its trace id. With `openTelemetry` on, the default takes the W3C trace id first and keeps an `x-request-id` that names the same trace, and the W3C trace is still read beside whatever this returns, so outbound calls stay in the caller's trace. |
| `traceIdKey`          | `'traceId'`                              | The key the trace id is stored under in the request context.                                                                                                                                         |
| `attachTraceIdToLogs` | `true`                                   | Adds the trace id to the `ConsoleLogger`'s own output, on Nest 11.2 and later. Sending lines to the dashboard is `forwardLogs`.                                                                       |
| `skipInstrumentation` | `() => false`                            | Returns `true` for a provider instance that must not be instrumented. Nest's `Reflector` and the `mongodb` driver's `MongoClient` and `Db` never are, whatever this returns.                         |

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

The MSSQL unit suite uses the real driver's public request APIs with stubbed transport methods and needs no SQL Server. The queue suites need a Redis, and the query-span integration suites a PostgreSQL, MySQL and MongoDB. Each integration suite skips itself when its server does not answer, so without them `test:int` passes having tested less. CI starts them with these ports and credentials, which the suites default to:

```bash
$ docker run -d -p 6379:6379 redis:7-alpine
$ docker run -d -p 54321:5432 -e POSTGRES_PASSWORD=postgres-whisprr postgres:16-alpine
$ docker run -d -p 3306:3306 -e MYSQL_ROOT_PASSWORD=root -e MYSQL_DATABASE=test mysql:8
$ docker run -d -p 27027:27017 mongo:7
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

`@nestjs/observe` is source-available under the [NestJS Observe Agent License](LICENSE): free to use and modify to send your applications' telemetry to NestJS Observe. Version 0.3.20 and earlier remain [MIT licensed](NOTICE).
