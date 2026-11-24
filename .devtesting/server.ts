/** LOCAL TEST HARNESS ONLY: serves backend/ over HTTP for integration tests. */
import { createServer } from 'node:http';
import { handler } from '../backend/index';

const port = Number(process.env.PORT || 8787);

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = chunks.length ? Buffer.concat(chunks).toString('utf8') : '';

  const event = {
    rawPath: url.pathname,
    requestContext: { http: { method: req.method } },
    headers: req.headers,
    queryStringParameters: Object.fromEntries(url.searchParams.entries()),
    body: body || null,
  };

  try {
    const result: any = await (handler as any)(event);
    res.statusCode = result?.statusCode || 200;
    res.setHeader('content-type', 'application/json');
    res.end(result?.body ?? '');
  } catch (e: any) {
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: String(e?.message || e) }));
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log('harness listening on ' + port);
});
