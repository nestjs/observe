# Overhead benchmark

Measures what `@nestjs/observe` costs the application it runs in: CPU per
request, latency, throughput, memory, idle CPU and startup. The figures in the
main README's [Overhead](../README.md#overhead) section come from here.

```bash
# Builds the package and the harness, then runs the four scenarios with and
# without the agent (about 8 minutes)
npm run bench

# One scenario, once
npm run bench -- --scenarios typical --reps 1

# Steadier numbers, `enabled: false` and a second load level too (about 40 minutes)
npm run bench -- --configs baseline,disabled,on --reps 3 --duration 20 --rates 150,1000
```

Results land in `bench/results/<timestamp>/`: `raw.json` with every
measurement, and `summary.md` / `summary.json` with medians across
repetitions and the difference each configuration makes against the
baseline. `node bench/.build/summary.js <raw.json>` summarises a run again.

It needs [wrk](https://github.com/wg/wrk) on the `PATH` for the saturation
phase, and Node 22.19 or later for the main thread's share of the CPU. Run it
on a machine that is otherwise idle: the load generator and the application
share it, and the summary reports the load average at the start and the end so
a noisy run can be told apart.

## What runs

One Nest application (`src/app.module.ts`) serves four request shapes:

| Scenario  | Route        | What it does                                                                                                                                                                    |
| --------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hello`   | `/hello`     | A controller returning a string: one traced call.                                                                                                                               |
| `typical` | `/orders/42` | A guard, an interceptor, `ParseIntPipe`, a controller, a service and two repositories that each await an event-loop turn the way a query would; a 1 KB body. Nine traced calls. |
| `chatty`  | `/report`    | A service formatting 100 rows through another provider: 102 traced calls, 100 of them collapsed before shipping.                                                                |
| `compute` | `/quote`     | One provider method pricing 1,000 cart lines, reading two of its own fields per line through the instrumentation proxy.                                                         |

Each runs under each configuration, a fresh process every time:

| Configuration | What is installed                                                                                                                                                |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `baseline`    | Nothing: no `ObserveModule`, no `instrument`, the package never imported.                                                                                        |
| `disabled`    | `ObserveModule.forRoot({ enabled: false })` and `instrument` - the way the README tells an environment to opt out. Opt-in, through `--configs`.                  |
| `on`          | Defaults, with `endpoint` pointing at a local sink that accepts and validates every batch.                                                                       |
| `reference`   | The same as `on`, with the package built from `--reference <dir>` (its `package.json` and `dist`), to measure a change against what it replaces in the same run. |

`baseline` and `on` run by default. Configurations are interleaved and rotated
each repetition, so drift on the machine falls on all of them alike - which
takes as many repetitions as there are configurations.

## Phases of one run

1. **Warm-up**: 5 s at 1,000 rps, a rate the app sustains, so the JIT is warm
   without the heap being sized for a burst.
2. **Fixed rate**, open loop, for 10 s at each of `--rates` (150 rps by
   default): the latency a lightly loaded process adds. Requests leave on a
   schedule whatever the server is doing, so a stall is charged for every
   request it delays. 150 rps stays under the default `maxTracesPerBatch`
   (1,000 per 5 s flush), so every trace is encoded and shipped; at 1,000 rps
   the agent ships about one request in five.
3. **Saturation**: 10 s of wrk (`-t2 -c64`), the most one process serves and
   the CPU per request when it is fully busy. Over a hundred thousand
   requests, so one run already pins CPU per request down.

Before those, `--boots` (3 by default) starts each configuration on its own:
the time to listening, the memory at boot, and the CPU it spends idling for
`--idle` seconds (5) after a 2 s settle - the agent's timers and worker thread
with no traffic at all.

CPU comes from inside the application, over its IPC channel:
`process.cpuUsage()` for every thread of the process (the agent's worker
included) and `process.threadCpuUsage()` for the thread that serves requests.

## Why the app runs outside the repository

The agent instruments every optional peer it can resolve - `pg`, `mysql2`,
`mssql`, `mongodb`, Bull, BullMQ, microservices - by loading it at startup,
and this repository has all of them installed for its own test suites. The
runner therefore lays the application out in a directory of its own
(`--app-dir`, in the OS temp directory by default) with only Nest and a copy of
the package in its `node_modules`, the way an application that uses none of
those drivers is installed.

## Profiling by hand

`BENCH_SINK_PORT` and `BENCH_PORT` fix the ports, so the app can be run alone
under `--cpu-prof` after a run has laid out its directory:

```bash
BENCH_SINK_PORT=47901 node bench/.build/sink.js &
cd "$TMPDIR/nestjs-observe-bench-app" && \
  BENCH_CONFIG=on BENCH_SINK_URL=http://127.0.0.1:47901 BENCH_PORT=47902 \
  node --cpu-prof server.js
```
