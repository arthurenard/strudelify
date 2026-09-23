/** Request queue: per-host spacing, token buckets, exponential backoff, cool-downs and cancellation. See ../art.ts. */
import { HttpError, abortError, isAbort } from './types.js';

export interface HostPolicy {
  /** Minimum ms between two request starts on the host. */
  gap?: number;
  /** Retries of one request before giving up on it (0 = none). */
  maxRetries?: number;
  /** First retry delay, doubled on every further attempt. */
  baseDelay?: number;
  /** Lane cool-down once a request has exhausted its retries; doubles with each consecutive failure. */
  cooldown?: number;
  /**
   * Token bucket on top of the spacing: at most `burst` requests at once, refilled at `perMinute`. Keeps a user
   * flipping through uncached songs under the host's published limit (iTunes: ~20/min) instead of tripping a
   * 403 and losing the host for a cool-down. Off when `perMinute` is unset.
   */
  burst?: number;
  perMinute?: number;
}

export interface QueueOptions extends HostPolicy {
  /** @deprecated use `hostPolicy` – kept for callers that only tune the spacing. */
  hostGap?: Record<string, number>;
  hostPolicy?: Record<string, HostPolicy>;
  /** Cap for one retry delay. */
  maxDelay?: number;
  /** Cap for a lane cool-down. */
  maxCooldown?: number;
  jitter?: boolean;
  onRetry?: (info: { host: string; attempt: number; delay: number; error: unknown }) => void;
  /** Called when a request gave up and the lane was put on cool-down. */
  onCooldown?: (info: { host: string; streak: number; ms: number; error: unknown }) => void;
  /** Called when an attempt starts, with the ms the job spent waiting for its lane (spacing, back-off, queue). */
  onStart?: (info: { host: string; url: string; attempt: number; waited: number }) => void;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

/**
 * Per-host tuning. iTunes answers 403 the moment ~20 requests/min are exceeded, and keeps doing so for a
 * while: a token bucket (6 at once, then one every 3 s) keeps a browser session under that limit – the first
 * songs of a session pay nothing, a fast flipper waits ≤ 3 s, well inside the budget – and, should a 403 still
 * come, one quick retry, then a long cool-down that lets the chain move on to Deezer immediately.
 * MusicBrainz asks for ≤ 1 request/s and returns transient 503s.
 */
export const DEFAULT_HOST_POLICY: Record<string, HostPolicy> = {
  'itunes.apple.com': { gap: 350, burst: 6, perMinute: 20, maxRetries: 1, baseDelay: 1000, cooldown: 20_000 },
  'api.deezer.com': { gap: 200, maxRetries: 2, baseDelay: 800, cooldown: 10_000 },
  'musicbrainz.org': { gap: 1100, maxRetries: 2, baseDelay: 1500, cooldown: 15_000 },
  'coverartarchive.org': { gap: 350, maxRetries: 1, baseDelay: 1000, cooldown: 10_000 },
};

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(t);
      reject(abortError());
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function isRetryable(e: unknown): boolean {
  if (isAbort(e)) return false;
  if (e instanceof HttpError) return e.status === 403 || e.status === 408 || e.status === 425 || e.status === 429 || e.status >= 500;
  return true; // network / JSONP timeout / CORS failure
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

interface Lane {
  tail: Promise<void>;
  lastStart: number;
  /** Earliest next start: retry back-off or cool-down after a run of failures. */
  notBefore: number;
  /** Consecutive requests that exhausted their retries (reset by any success). */
  streak: number;
  /** Token bucket state (only used when the host policy sets `perMinute`). */
  tokens: number;
  refilled: number;
}

export class RequestQueue {
  private lanes = new Map<string, Lane>();
  private readonly o: Required<Omit<QueueOptions, 'onRetry' | 'onCooldown' | 'onStart' | 'hostGap' | 'hostPolicy'>> & Pick<QueueOptions, 'onRetry' | 'onCooldown' | 'onStart'>;
  private readonly policy: Record<string, HostPolicy>;
  constructor(opts: QueueOptions = {}) {
    this.o = {
      gap: opts.gap ?? 350,
      maxRetries: opts.maxRetries ?? 2,
      baseDelay: opts.baseDelay ?? 1000,
      cooldown: opts.cooldown ?? 15_000,
      burst: opts.burst ?? 1,
      perMinute: opts.perMinute ?? 0,
      maxDelay: opts.maxDelay ?? 30_000,
      maxCooldown: opts.maxCooldown ?? 120_000,
      jitter: opts.jitter ?? true,
      sleep: opts.sleep ?? sleep,
      now: opts.now ?? (() => Date.now()),
      onRetry: opts.onRetry,
      onCooldown: opts.onCooldown,
      onStart: opts.onStart,
    };
    this.policy = { ...(opts.hostPolicy ?? {}) };
    for (const [h, gap] of Object.entries(opts.hostGap ?? {})) this.policy[h] = { ...this.policy[h], gap };
  }

  private lane(host: string): Lane {
    let l = this.lanes.get(host);
    if (!l) {
      l = { tail: Promise.resolve(), lastStart: -Infinity, notBefore: 0, streak: 0, tokens: Infinity, refilled: this.o.now() };
      this.lanes.set(host, l);
    }
    return l;
  }

  private policyFor(host: string): Required<HostPolicy> {
    const p = this.policy[host] ?? {};
    return {
      gap: p.gap ?? this.o.gap,
      maxRetries: p.maxRetries ?? this.o.maxRetries,
      baseDelay: p.baseDelay ?? this.o.baseDelay,
      cooldown: p.cooldown ?? this.o.cooldown,
      burst: Math.max(1, p.burst ?? this.o.burst),
      perMinute: p.perMinute ?? this.o.perMinute,
    };
  }

  /** Refill the lane's token bucket and return the earliest time a token is available (0 = now). */
  private tokenReady(lane: Lane, p: Required<HostPolicy>): number {
    if (!p.perMinute) return 0;
    const now = this.o.now();
    const rate = p.perMinute / 60_000; // tokens per ms
    lane.tokens = Math.min(p.burst, lane.tokens + (now - lane.refilled) * rate);
    lane.refilled = now;
    return lane.tokens >= 1 ? 0 : now + Math.ceil((1 - lane.tokens) / rate);
  }

  /** Ms a request on the host of `url` would wait for its token bucket right now (0 = none; spacing not included). */
  bucketWait(url: string): number {
    const host = hostOf(url);
    const p = this.policyFor(host);
    if (!p.perMinute) return 0;
    return Math.max(0, this.tokenReady(this.lane(host), p) - this.o.now());
  }

  private jitter(ms: number): number {
    return this.o.jitter ? Math.round(ms * (0.8 + Math.random() * 0.4)) : ms;
  }

  /** Ms until the host of `url` is out of its failure cool-down / retry back-off (0 when it is usable now). */
  cooldown(url: string): number {
    const lane = this.lanes.get(hostOf(url));
    return lane ? Math.max(0, lane.notBefore - this.o.now()) : 0;
  }

  /** Run `fn` when its host lane is free. Aborted jobs are skipped without consuming a slot. */
  run<T>(url: string, fn: (attempt: number) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const host = hostOf(url);
    const lane = this.lane(host);
    const p = this.policyFor(host);
    const enqueued = this.o.now();
    const job = lane.tail.then(async () => {
      if (signal?.aborted) throw abortError();
      for (let attempt = 0; ; attempt++) {
        const wait = Math.max(lane.lastStart + p.gap, lane.notBefore, this.tokenReady(lane, p)) - this.o.now();
        if (wait > 0) await this.o.sleep(wait, signal);
        if (signal?.aborted) throw abortError(); // never consumed a token: the next job gets it
        this.tokenReady(lane, p);
        if (p.perMinute) lane.tokens -= 1;
        lane.lastStart = this.o.now();
        this.o.onStart?.({ host, url, attempt, waited: attempt === 0 ? lane.lastStart - enqueued : Math.max(0, wait) });
        try {
          const v = await fn(attempt);
          lane.streak = 0;
          return v;
        } catch (e) {
          if (!isRetryable(e)) throw e;
          if (attempt >= p.maxRetries) {
            // Give up on this request and put the lane on cool-down so the chain (and later lookups) skip
            // the host instead of queueing behind more failures.
            lane.streak++;
            const ms = this.jitter(Math.min(this.o.maxCooldown, p.cooldown * 2 ** (lane.streak - 1)));
            lane.notBefore = this.o.now() + ms;
            this.o.onCooldown?.({ host, streak: lane.streak, ms, error: e });
            throw e;
          }
          const delay = this.jitter(Math.min(this.o.maxDelay, p.baseDelay * 2 ** attempt));
          // Stored on the lane so that later jobs (even after this one is cancelled) respect it.
          lane.notBefore = this.o.now() + delay;
          this.o.onRetry?.({ host, attempt, delay, error: e });
        }
      }
    });
    lane.tail = job.then(
      () => undefined,
      () => undefined,
    );
    return job;
  }
}
