import http from 'node:http';

const host = process.env.XWX_METADATA_PUSH_HOST || '0.0.0.0';
const port = Number(process.env.XWX_METADATA_PUSH_PORT) || 7375;
let revision = Date.now();
const clients = new Set();
const allTopics = ['models', 'capabilities', 'pricing'];

const server = http.createServer((request, response) => {
  void handleRequest(request, response).catch(error => {
    const status = error instanceof RequestError ? error.status : 500;
    const message = error instanceof RequestError ? error.message : 'internal server error';
    if (!response.headersSent) json(response, status, { error: message });
    else response.destroy();
    if (!(error instanceof RequestError)) console.error('[metadata-push] request failed', error);
  });
});

async function handleRequest(request, response) {
  const url = new URL(request.url || '/', 'http://127.0.0.1');
  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type'
    });
    response.end();
    return;
  }
  if (request.method === 'GET' && url.pathname === '/health') {
    json(response, 200, { ok: true, revision, clients: clients.size });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/events') {
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'access-control-allow-origin': '*'
    });
    response.write(': connected\n\n');
    clients.add(response);
    const removeClient = () => clients.delete(response);
    response.on('close', removeClient);
    response.on('error', removeClient);
    const lastEventId = String(request.headers['last-event-id'] || '').trim();
    if (lastEventId && lastEventId !== String(revision)) {
      response.write(metadataFrame({
        revision,
        topics: allTopics,
        emittedAt: new Date().toISOString()
      }));
    }
    return;
  }
  if (request.method === 'POST' && url.pathname === '/invalidate') {
    if (!isLoopback(request.socket.remoteAddress)) {
      json(response, 403, { error: 'local admin only' });
      return;
    }
    const body = await readJson(request);
    const topics = normalizeTopics(body.topics);
    if (!topics.length) {
      json(response, 400, { error: 'topics must include models, capabilities, or pricing' });
      return;
    }
    revision = Math.max(revision + 1, Date.now());
    const event = { revision, topics, emittedAt: new Date().toISOString() };
    const frame = metadataFrame(event);
    for (const client of [...clients]) {
      try { client.write(frame); } catch { clients.delete(client); }
    }
    json(response, 200, { ...event, clients: clients.size });
    return;
  }
  response.writeHead(404);
  response.end('Not found');
}

const heartbeat = setInterval(() => {
  for (const client of [...clients]) {
    try { client.write(`: heartbeat ${Date.now()}\n\n`); } catch { clients.delete(client); }
  }
}, 25_000);
heartbeat.unref();

server.listen(port, host, () => {
  console.log(`[metadata-push] listening at http://${host}:${port}`);
});

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*'
  });
  response.end(body);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw new RequestError(413, 'request too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new RequestError(400, 'invalid JSON body');
  }
}

function normalizeTopics(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(topic => ['models', 'capabilities', 'pricing'].includes(topic)))];
}

function isLoopback(value = '') {
  return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1';
}

function metadataFrame(event) {
  return `id: ${event.revision}\nevent: metadata\ndata: ${JSON.stringify(event)}\n\n`;
}

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
