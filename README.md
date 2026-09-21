<p align="center">
  <a href="https://observe.nestjs.com" target="_blank"><img src="https://nestjs.com/img/logo-small.svg" width="120" alt="NestJS Logo" /></a>
</p>

<p align="center">Auto-instrumented observability for <a href="https://nestjs.com" target="_blank">NestJS</a> applications — traces, errors, logs, jobs and profiles, with no manual span wiring.</p>

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
  BullMQ consumers and `@nestjs/schedule` cron, interval and timeout jobs.
- **Distributed traces** with per-span self time, correlated across services.
- **Errors**, grouped by fingerprint, with the source frame and the trace that
  produced them.
- **Logs**, correlated to the request that wrote them.
- **Runtime and custom metrics**, plus on-demand **CPU profiles**.

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
  await app.listen(3000);
}
bootstrap();
```

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

## What it records without any code

Once the module and the instrument are in place, the agent reports, with no further changes to your application:

- **Requests, GraphQL operations, RPC messages, WebSocket gateway messages, queue jobs and scheduled jobs**, each with its tree of provider method calls.
- **Database queries**, as a span under the method that ran them, for `pg`, `mysql2` and `mongodb`. Anything built on those drivers is covered without being known by name: TypeORM, Drizzle, MikroORM and Mongoose are tested in this repository, and others (Knex, Sequelize) go through the same driver calls. The statement is recorded with every value removed (`SELECT "o"."id" FROM "orders" "o" WHERE "o"."customer_id" = $1`). Prisma's Rust query engine does not go through these drivers and is not covered yet.
- **Outbound HTTP calls** made with `fetch`/`undici` or `node:http`/`https` (so Axios too), as `POST api.stripe.com`. The current trace id is forwarded as `x-request-id`, so a service that also runs the agent continues the same trace; a header you set yourself is never overwritten.
- **Trace ids across queues**: a BullMQ or Bull job enqueued while handling a request carries that request's trace id, so the request and its job show up as one trace. Repeatable (cron) jobs start their own.

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

## Optional peer dependencies

Protocol integrations are only loaded when you use them, and their packages are optional peers:

- `@nestjs/microservices` - RPC/microservice instrumentation
- `@nestjs/graphql` - GraphQL operation instrumentation
- `@nestjs/bullmq` and `bullmq` - queue/job instrumentation
- `@nestjs/bull` and `bull` - the same, for legacy Bull
- `@nestjs/websockets` - WebSocket gateway instrumentation (`ws` and socket.io adapters)
- `@nestjs/schedule` - scheduled job (`@Cron`, `@Interval`, `@Timeout`) instrumentation

## Test

```bash
# unit tests
$ npm test

# integration tests (boot real Nest apps on real ports)
$ npm run test:int
```

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
