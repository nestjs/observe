"use strict";

/**
 * A Node service instrumented with OpenTelemetry the zero-code way: started
 * with `--require @opentelemetry/auto-instrumentations-node/register` and
 * configured by `OTEL_*` variables alone, as the OpenTelemetry Operator
 * injects it. There is no tracing code here, which is the point - this is
 * what the services around a Nest service run when a team says it already
 * has OpenTelemetry. See `opentelemetry-service.ts`, which starts it.
 *
 * With `NEXT_URL` set it passes every request on to that service, and
 * `x-request-id` with it, as a mesh's sidecar does. Without, it answers with
 * the headers the request arrived with.
 */
const http = require("node:http");

const next = process.env.NEXT_URL;

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    if (!next) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ headers: req.headers, rawHeaders: req.rawHeaders }),
      );
      return;
    }
    const headers = {};
    for (const name of ["content-type", "x-request-id"]) {
      if (typeof req.headers[name] === "string") {
        headers[name] = req.headers[name];
      }
    }
    const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
    fetch(`${next}${req.url}`, { method: req.method, headers, body })
      .then(async (response) => {
        res.writeHead(response.status, {
          "content-type":
            response.headers.get("content-type") ?? "application/json",
        });
        res.end(await response.text());
      })
      .catch((error) => {
        res.writeHead(502, { "content-type": "text/plain" });
        res.end(String(error));
      });
  });
});

server.listen(0, "127.0.0.1", () => {
  process.send({ port: server.address().port });
});

// The suite that started it is gone, or done with it.
process.on("disconnect", () => process.exit(0));
