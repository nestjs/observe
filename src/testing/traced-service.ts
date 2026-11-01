import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

export interface TracedService {
  /** Where it listens, on 127.0.0.1. */
  readonly url: string;
  stop(): Promise<void>;
}

export interface TracedServiceLaunch {
  /** What it is called in errors - and, for the tracer, in `env`. */
  name: string;
  /** Loads the tracer first: a `--require` of its zero-code entry point. */
  execArgv: string[];
  /** Configures the tracer. The service gets nothing else from this one. */
  env: Record<string, string>;
  /** Where it passes every request on to; left out, it answers them itself. */
  next?: string;
}

/**
 * Starts `traced-service.cjs` under the tracer `execArgv` loads, and resolves
 * once it listens.
 *
 * It runs in a process of its own because a tracer instruments the whole
 * process it starts in: started in a suite's, it would instrument the Nest
 * service under test too, and the setup these services stand for has the
 * tracer in the services around that one, not in it.
 */
export async function startTracedService(
  launch: TracedServiceLaunch,
): Promise<TracedService> {
  const stderr: string[] = [];
  const child = fork(
    fileURLToPath(new URL("./traced-service.cjs", import.meta.url)),
    [],
    {
      execArgv: launch.execArgv,
      // Nothing from this environment, so no variable a developer has set
      // changes what the tracer does.
      env: {
        PATH: process.env.PATH,
        ...launch.env,
        ...(launch.next ? { NEXT_URL: launch.next } : {}),
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(String(chunk)));

  const port = await new Promise<number>((resolve, reject) => {
    const settle = (error?: Error, listening?: number) => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
      child.off("error", settle);
      if (error) {
        child.kill("SIGKILL");
        reject(
          new Error(
            `The ${launch.name} service did not start: ${error.message}\n${stderr.join("")}`,
          ),
        );
      } else {
        resolve(listening!);
      }
    };
    const onMessage = (message: { port?: number }) => {
      if (typeof message?.port === "number") {
        settle(undefined, message.port);
      }
    };
    const onExit = (code: number | null, signal: string | null) =>
      settle(new Error(`it exited (${code ?? signal}) before listening`));
    const timer = setTimeout(
      () => settle(new Error("it was not listening after 20 seconds")),
      20_000,
    );
    child.on("message", onMessage);
    child.once("exit", onExit);
    child.once("error", settle);
  });

  return {
    url: `http://127.0.0.1:${port}`,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      const exited = new Promise((resolve) => child.once("exit", resolve));
      // It exits when the channel closes. A tracer may keep SIGTERM for its
      // own shutdown, as OpenTelemetry's does, which does not end the
      // process.
      child.disconnect();
      const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      await exited;
      clearTimeout(timer);
    },
  };
}
