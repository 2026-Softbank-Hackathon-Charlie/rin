import http from 'node:http';

/** Serves GET /healthz with 200 while `isHealthy()` is true, 503 otherwise. */
export function startHealthServer(port: number, isHealthy: () => boolean): http.Server {
  const server = http.createServer((req, res) => {
    if (req.url !== '/healthz') {
      res.writeHead(404).end();
      return;
    }
    const ok = isHealthy();
    res.writeHead(ok ? 200 : 503, { 'content-type': 'text/plain' }).end(ok ? 'ok' : 'unhealthy');
  });
  server.listen(port);
  return server;
}
