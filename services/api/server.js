// Minimal demo API deployed by DevCommandHub. No dependencies.
const http = require('http');

const VERSION = process.env.APP_VERSION || 'dev';
const PORT = Number(process.env.PORT || 8080);
const startedAt = new Date().toISOString();

const server = http.createServer((req, res) => {
  const body = req.url === '/healthz'
    ? { ok: true }
    : { service: 'api', version: VERSION, pod: process.env.HOSTNAME, startedAt };
  console.log(`${new Date().toISOString()} ${req.method} ${req.url} -> 200`);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
});

server.listen(PORT, () => console.log(`api ${VERSION} listening on :${PORT}`));
process.on('SIGTERM', () => { console.log('api shutting down'); server.close(() => process.exit(0)); });
