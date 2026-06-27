#!/usr/bin/env bun

type Release = () => void;

type QueueEntry = {
  readonly resolve: (release: Release) => void;
  readonly reject: (error: Error) => void;
  readonly enqueuedAt: number;
  readonly signal?: AbortSignal;
};

const upstreamBase = new URL(process.env.UMANS_LIMITER_UPSTREAM ?? "https://api.code.umans.ai");
const hostname = process.env.UMANS_LIMITER_HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.UMANS_LIMITER_PORT ?? "8318", 10);
const maxConcurrent = Math.max(1, Number.parseInt(process.env.UMANS_LIMITER_MAX_CONCURRENCY ?? "4", 10));

let active = 0;
let completed = 0;
let failed = 0;
let totalQueuedWaitMs = 0;
const queue: QueueEntry[] = [];

function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init?.headers ?? {}),
    },
  });
}

function stats() {
  return {
    active,
    queued: queue.length,
    maxConcurrent,
    completed,
    failed,
    averageQueuedWaitMs: completed > 0 ? Math.round(totalQueuedWaitMs / completed) : 0,
    upstream: upstreamBase.origin,
    limitedPolicy: "all upstream requests",
  };
}

function dequeue(): void {
  while (active < maxConcurrent && queue.length > 0) {
    const entry = queue.shift()!;
    if (entry.signal?.aborted) {
      entry.reject(new Error("Request aborted while queued"));
      continue;
    }
    active += 1;
    totalQueuedWaitMs += Date.now() - entry.enqueuedAt;
    let released = false;
    entry.resolve(() => {
      if (released) return;
      released = true;
      active -= 1;
      completed += 1;
      dequeue();
    });
  }
}

async function acquire(signal?: AbortSignal): Promise<Release> {
  if (signal?.aborted) throw new Error("Request aborted before limiter acquire");
  if (active < maxConcurrent) {
    active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active -= 1;
      completed += 1;
      dequeue();
    };
  }

  const { promise, resolve, reject } = Promise.withResolvers<Release>();
  const entry: QueueEntry = { resolve, reject, enqueuedAt: Date.now(), signal };
  queue.push(entry);

  const abort = () => {
    const index = queue.indexOf(entry);
    if (index !== -1) queue.splice(index, 1);
    reject(new Error("Request aborted while queued"));
  };
  signal?.addEventListener("abort", abort, { once: true });

  try {
    return await promise;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

function targetUrl(req: Request): URL {
  const incoming = new URL(req.url);
  const target = new URL(upstreamBase.href);
  target.pathname = incoming.pathname;
  target.search = incoming.search;
  return target;
}

function forwardHeaders(req: Request): Headers {
  const headers = new Headers(req.headers);
  headers.delete("host");
  headers.delete("connection");
  headers.delete("keep-alive");
  headers.delete("proxy-authenticate");
  headers.delete("proxy-authorization");
  headers.delete("te");
  headers.delete("trailer");
  headers.delete("transfer-encoding");
  headers.delete("upgrade");
  return headers;
}

function responseHeaders(upstream: Response): Headers {
  const headers = new Headers(upstream.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  headers.set("x-umans-limiter-active", String(active));
  headers.set("x-umans-limiter-queued", String(queue.length));
  return headers;
}

function releaseOnBodyClose(body: ReadableStream<Uint8Array>, release: Release): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let released = false;
  const done = () => {
    if (released) return;
    released = true;
    release();
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          done();
          controller.close();
          return;
        }
        controller.enqueue(chunk.value);
      } catch (error) {
        done();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        done();
      }
    },
  });
}

function isLimitedRequest(_req: Request): boolean {
  return true;
}

async function proxy(req: Request, limited: boolean): Promise<Response> {
  let release: Release | undefined;
  if (limited) release = await acquire(req.signal);

  try {
    const upstream = await fetch(targetUrl(req), {
      method: req.method,
      headers: forwardHeaders(req),
      body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
      signal: req.signal,
    });

    const headers = responseHeaders(upstream);
    if (!upstream.body) {
      release?.();
      return new Response(null, { status: upstream.status, statusText: upstream.statusText, headers });
    }

    const body = release ? releaseOnBodyClose(upstream.body, release) : upstream.body;
    return new Response(body, { status: upstream.status, statusText: upstream.statusText, headers });
  } catch (error) {
    if (release) {
      failed += 1;
      release();
    }
    if (req.signal.aborted) {
      return json({ error: "client_aborted" }, { status: 499 });
    }
    return json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 });
  }
}

Bun.serve({
  hostname,
  port,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") return json({ ok: true, ...stats() });
    if (url.pathname === "/metrics") return json(stats());

    const limited = isLimitedRequest(req);
    return proxy(req, limited);
  },
});

console.log(`umans-limiter listening on http://${hostname}:${port} -> ${upstreamBase.origin} with max ${maxConcurrent}`);
