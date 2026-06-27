import { afterEach, expect, test } from 'bun:test';
import net from 'node:net';

const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

interface ChildProcessHandle {
  kill(signal?: string): void;
  stdout?: ReadableStream<Uint8Array> | null;
  stderr?: ReadableStream<Uint8Array> | null;
  exited: Promise<number>;
}

interface ServerHandle {
  stop(closeActiveConnections?: boolean): void;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

const children: ChildProcessHandle[] = [];
const servers: ServerHandle[] = [];


function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
}

function freePort(): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    server.close(() => resolve(port));
  });
  return promise;
}

async function waitForOutput(stream: ReadableStream<Uint8Array> | null | undefined, needle: string): Promise<void> {
  if (!stream) throw new Error('missing process stdout stream');
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error(`process exited before output contained ${needle}`);
    buffer += decoder.decode(chunk.value, { stream: true });
    if (buffer.includes(needle)) return;
  }
}

afterEach(() => {
  for (const child of children.splice(0)) child.kill();
  for (const server of servers.splice(0)) server.stop(true);
});

test('strict limiter allows only one upstream request when max concurrency is one', async () => {
  const upstreamPort = await freePort();
  const limiterPort = await freePort();
  const entered = [Promise.withResolvers<void>(), Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const releases = [Promise.withResolvers<void>(), Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  let active = 0;
  let maxActive = 0;
  let count = 0;

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: upstreamPort,
    async fetch() {
      const index = count++;
      active += 1;
      maxActive = Math.max(maxActive, active);
      entered[index]?.resolve();
      await releases[index]?.promise;
      active -= 1;
      return json({ ok: true, index });
    },
  });
  servers.push(server);

  const limiter = Bun.spawn({
    cmd: ['bun', 'run', 'src/umans-limiter.ts'],
    cwd: root,
    env: {
      ...process.env,
      UMANS_LIMITER_HOST: '127.0.0.1',
      UMANS_LIMITER_PORT: String(limiterPort),
      UMANS_LIMITER_MAX_CONCURRENCY: '1',
      UMANS_LIMITER_UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  children.push(limiter);
  const ready = waitForOutput(limiter.stdout, 'umans-limiter listening');
  limiter.stderr?.pipeTo(new WritableStream({ write() {} })).catch(() => {});
  await Promise.race([
    ready,
    limiter.exited.then(code => { throw new Error(`limiter exited before ready with code ${code}`); }),
  ]);

  const requests = [0, 1, 2].map(i => fetch(`http://127.0.0.1:${limiterPort}/v1/test/${i}`, { method: 'POST', body: String(i) }));
  const statuses: number[] = [];

  async function consumeResponse(index: number): Promise<void> {
    const response = await requests[index];
    statuses[index] = response.status;
    await response.text();
  }

  await entered[0].promise;
  expect(count).toBe(1);
  expect(maxActive).toBe(1);

  releases[0].resolve();
  await consumeResponse(0);
  await entered[1].promise;
  expect(count).toBe(2);
  expect(maxActive).toBe(1);

  releases[1].resolve();
  await consumeResponse(1);
  await entered[2].promise;
  expect(count).toBe(3);
  expect(maxActive).toBe(1);

  releases[2].resolve();
  await consumeResponse(2);
  expect(statuses.every(status => status === 200)).toBe(true);

  const metrics = await fetch(`http://127.0.0.1:${limiterPort}/metrics`).then(resp => resp.json());
  expect(metrics.maxConcurrent).toBe(1);
  expect(metrics.limitedPolicy).toBe('all upstream requests');
  expect(metrics.completed).toBe(3);
});
