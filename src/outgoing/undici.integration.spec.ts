import { AsyncLocalStorage } from "node:async_hooks";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import { createServer, Server, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import {
  patchUndiciDispatch,
  patchUndiciUnwrap,
} from "./undici.integration.js";

const require = createRequire(import.meta.url);
const undici = require("undici") as typeof import("undici");

/**
 * The context `undici:request:create` fires in is the one the HTTP
 * integration reads the caller from - its trace, its span, its id to send on.
 */
describe("undici requests dispatched later", () => {
  const caller = new AsyncLocalStorage<string>();
  let created: Array<string | undefined>;
  const onCreate = () => created.push(caller.getStore());
  let server: Server;
  let held: ServerResponse[];
  let url: string;

  beforeAll(() => {
    patchUndiciDispatch(require("undici/lib/dispatcher/dispatcher-base"));
    patchUndiciUnwrap(require("undici/lib/handler/unwrap-handler"));
  });

  beforeEach(async () => {
    created = [];
    held = [];
    subscribe("undici:request:create", onCreate);
    server = createServer((req, res) => {
      req.resume();
      held.push(res);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterEach(async () => {
    unsubscribe("undici:request:create", onCreate);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const answer = () => held.shift()!.end("ok");
  const waitFor = async (check: () => boolean) => {
    for (let waited = 0; !check() && waited < 2_000; waited += 10) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  // A bounded pool hands a queued request to a client from another
  // request's socket event: without its own context back, the request is
  // recorded in - and sends on the id of - whichever request that was.
  it("creates a request a full pool queued in its own caller's context", async () => {
    const pool = new undici.Pool(url, { connections: 1 });
    try {
      const first = caller.run("first", () =>
        pool.request({ path: "/a", method: "GET" }),
      );
      await waitFor(() => held.length === 1);
      const second = caller.run("second", () =>
        pool.request({ path: "/b", method: "GET" }),
      );
      answer();
      await (await first).body.text();
      await waitFor(() => held.length === 1);
      answer();
      await (await second).body.text();

      expect(created).toEqual(["first", "second"]);
    } finally {
      await pool.close();
    }
  });

  // A redirect is followed from the response's events, which fire in the
  // context of the request that opened the socket - here an earlier one.
  it("creates a followed redirect in its caller's context", async () => {
    const agent = new undici.Agent({ connections: 1 }).compose(
      undici.interceptors.redirect({ maxRedirections: 1 }),
    );
    try {
      const opening = caller.run("opener", () =>
        undici.request(`${url}/open`, { dispatcher: agent }),
      );
      await waitFor(() => held.length === 1);
      answer();
      await (await opening).body.text();

      const response = caller.run("caller", () =>
        undici.request(`${url}/from`, { dispatcher: agent }),
      );
      await waitFor(() => held.length === 1);
      held.shift()!.writeHead(302, { location: "/to" }).end();
      await waitFor(() => held.length === 1);
      answer();
      await (await response).body.text();

      expect(created).toEqual(["opener", "caller", "caller"]);
    } finally {
      await agent.close();
    }
  });
});
