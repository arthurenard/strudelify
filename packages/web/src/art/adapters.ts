/** Network adapters: `fetch` for Node and browsers, plus JSONP (Deezer) and `Image()` probes in the browser. See ../art.ts. */
import { DEFAULT_HOST_POLICY, RequestQueue } from './queue.js';
import { HttpError, abortError } from './types.js';
import type { ArtAdapter } from './types.js';

export interface FetchAdapterOptions {
  fetch?: typeof fetch;
  queue?: RequestQueue;
  /** Sent to MusicBrainz (they ask for one). Ignored by browsers (forbidden header). */
  userAgent?: string;
  /** Per-request timeout in ms. */
  timeout?: number;
}

/** Per-request timeout: shorter than the resolution budget, so one hung host cannot eat the whole budget. */
export const REQUEST_TIMEOUT = 7000;

export function defaultQueue(): RequestQueue {
  return new RequestQueue({ hostPolicy: DEFAULT_HOST_POLICY });
}

/**
 * Per-request timeout. Besides aborting the controller it also rejects `expired`, so a request is raced against
 * it: a fetch implementation that fails to honour an abort (seen with Node's undici on a stalled keep-alive
 * socket, which then leaves the event loop with nothing to wait on) can no longer hang the chain.
 */
function withTimeout(signal: AbortSignal | undefined, ms: number): { signal: AbortSignal; expired: Promise<never>; done: () => void } {
  const ctrl = new AbortController();
  let expire: (e: Error) => void = () => {};
  const expired = new Promise<never>((_, reject) => {
    expire = reject;
  });
  expired.catch(() => {}); // not every request awaits it
  const onAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) ctrl.abort();
  const t = setTimeout(() => {
    ctrl.abort();
    expire(new Error(`timeout after ${ms}ms`));
  }, ms);
  return {
    signal: ctrl.signal,
    expired,
    done: () => {
      clearTimeout(t);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

/** Adapter for any runtime with `fetch` (Node ≥ 18, browsers). Deezer goes through plain JSON here. */
export function createFetchAdapter(opts: FetchAdapterOptions = {}): ArtAdapter {
  const f = opts.fetch ?? globalThis.fetch;
  const queue = opts.queue ?? defaultQueue();
  const timeout = opts.timeout ?? REQUEST_TIMEOUT;
  const baseHeaders: Record<string, string> = { Accept: 'application/json' };
  if (opts.userAgent) baseHeaders['User-Agent'] = opts.userAgent;
  return {
    // A host is as busy as its failure cool-down or its rate limit says, whichever is longer: a lookup skips an
    // iTunes whose per-minute allowance was spent (by thumbnails, say) instead of queueing behind it.
    cooldown: (url) => Math.max(queue.cooldown(url), queue.bucketWait(url)),
    json(url, init) {
      return queue.run(
        url,
        async () => {
          const t = withTimeout(init?.signal, timeout);
          try {
            const res = await Promise.race([f(url, { headers: { ...baseHeaders, ...init?.headers }, signal: t.signal }), t.expired]);
            if (!res.ok) throw new HttpError(res.status, url);
            return (await Promise.race([res.json(), t.expired])) as unknown;
          } catch (e) {
            if (init?.signal?.aborted) throw abortError();
            throw e;
          } finally {
            t.done();
          }
        },
        init?.signal,
      );
    },
    imageExists(url, init) {
      return queue.run(
        url,
        async () => {
          const t = withTimeout(init?.signal, timeout);
          try {
            const res = await Promise.race([f(url, { method: 'HEAD', redirect: 'manual', signal: t.signal }), t.expired]);
            if (res.status === 404 || res.status === 400) return false;
            if (res.status >= 500 || res.status === 429 || res.status === 403) throw new HttpError(res.status, url);
            return res.status < 400;
          } catch (e) {
            if (init?.signal?.aborted) throw abortError();
            throw e;
          } finally {
            t.done();
          }
        },
        init?.signal,
      );
    },
  };
}

let jsonpCounter = 0;
/** How long a timed-out JSONP callback name stays defined for a late response, ms. */
const LATE_JSONP_MS = 60_000;

/** Browser adapter: fetch for CORS-enabled services, JSONP for Deezer, `Image()` probes for CAA. */
export function createBrowserAdapter(opts: FetchAdapterOptions = {}): ArtAdapter {
  const queue = opts.queue ?? defaultQueue();
  const base = createFetchAdapter({ ...opts, queue });
  const timeout = opts.timeout ?? REQUEST_TIMEOUT;
  return {
    json: base.json,
    cooldown: base.cooldown,
    jsonp(url, init) {
      return queue.run(
        url,
        () =>
          new Promise((resolve, reject) => {
            const name = `__strudelifyArt${++jsonpCounter}`;
            const w = window as unknown as Record<string, unknown>;
            const script = document.createElement('script');
            const cleanup = () => {
              // The script may still arrive after a timeout or an abort (removing the element does not stop
              // it): it then calls a no-op that removes itself, rather than a missing function that throws.
              w[name] = () => { delete w[name]; };
              setTimeout(() => { delete w[name]; }, LATE_JSONP_MS);
              script.remove();
              clearTimeout(timer);
              init?.signal?.removeEventListener('abort', onAbort);
            };
            const onAbort = () => {
              cleanup();
              reject(abortError());
            };
            const timer = setTimeout(() => {
              cleanup();
              reject(new Error(`jsonp timeout ${url}`));
            }, timeout);
            w[name] = (data: unknown) => {
              cleanup();
              resolve(data);
            };
            script.onerror = () => {
              cleanup();
              reject(new Error(`jsonp failed ${url}`));
            };
            init?.signal?.addEventListener('abort', onAbort, { once: true });
            script.src = `${url}${url.includes('?') ? '&' : '?'}output=jsonp&callback=${name}`;
            document.head.appendChild(script);
          }),
        init?.signal,
      );
    },
    imageExists(url, init) {
      return queue.run(
        url,
        () =>
          new Promise<boolean>((resolve, reject) => {
            if (init?.signal?.aborted) return reject(abortError());
            const img = new Image();
            const cleanup = () => {
              clearTimeout(timer);
              init?.signal?.removeEventListener('abort', onAbort);
              img.onload = img.onerror = null;
            };
            // Superseded lookup: drop the probe now instead of letting it run to the timeout.
            const onAbort = () => {
              cleanup();
              img.src = '';
              reject(abortError());
            };
            const timer = setTimeout(() => {
              cleanup();
              img.src = '';
              resolve(false);
            }, timeout);
            img.onload = () => {
              cleanup();
              resolve(img.naturalWidth > 1);
            };
            img.onerror = () => {
              cleanup();
              resolve(false);
            };
            init?.signal?.addEventListener('abort', onAbort, { once: true });
            img.src = url;
          }),
        init?.signal,
      );
    },
  };
}
