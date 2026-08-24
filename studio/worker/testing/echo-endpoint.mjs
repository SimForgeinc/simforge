// Stub model endpoint for model_run worker tests and demos: an HTTP process
// that echoes every /invoke body back, plus a /healthz probe. Speaks exactly
// the `process` + `http-json` descriptor contract in app/lib/models/contracts.ts.
import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 0);

const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/healthz") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true}');
    return;
  }
  if (request.method === "POST" && request.url === "/invoke") {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        response.writeHead(400, { "content-type": "application/json" });
        response.end('{"error":"invalid_json"}');
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, echo: body, servedAt: new Date().toISOString() }));
    });
    return;
  }
  response.writeHead(404, { "content-type": "application/json" });
  response.end('{"error":"not_found"}');
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`READY 127.0.0.1:${server.address().port}\n`);
});
