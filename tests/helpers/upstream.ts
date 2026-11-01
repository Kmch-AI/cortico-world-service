/** 测试用的真本地上游:记录请求,按回调回应。 */
import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';

export interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

export interface Upstream {
  url: string;
  port: number;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

export type UpstreamHandler = (req: RecordedRequest, res: ServerResponse) => void | Promise<void>;

export function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

export function audio(res: ServerResponse, bytes: Uint8Array, mime = 'audio/wav'): void {
  res.writeHead(200, {
    'content-type': mime,
    'content-length': bytes.length,
  });
  res.end(Buffer.from(bytes));
}

export function startUpstream(handler: UpstreamHandler): Promise<Upstream> {
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const recorded: RecordedRequest = {
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(recorded);
      try {
        const result = handler(recorded, res);
        if (result instanceof Promise) {
          void result.catch(() => {
            if (!res.writableEnded) json(res, 500, { error: 'handler failed' });
          });
        }
      } catch {
        if (!res.writableEnded) json(res, 500, { error: 'handler failed' });
      }
    });
  });

  return new Promise<Upstream>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        port,
        requests,
        close: () => new Promise<void>((done) => {
          server.close(() => done());
          server.closeAllConnections?.();
        }),
      });
    });
  });
}
