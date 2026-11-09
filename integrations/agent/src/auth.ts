// The gateway's local security checks: Host (blocks DNS rebinding), Origin (blocks browsers unless one origin is
// allowed exactly), the bearer token (compared in constant time) and the local send limit.
import { createHash, timingSafeEqual } from 'node:crypto';

/** The only address the gateway binds. There is no option to bind anywhere else. */
export const BIND_HOST = '127.0.0.1';

/** Host must be 127.0.0.1:<port> or localhost:<port>. */
export function hostAllowed(host: string | undefined, port: number): boolean {
  if (!host) return false;
  const h = host.trim().toLowerCase();
  return h === `127.0.0.1:${port}` || h === `localhost:${port}`;
}

/** No Origin header (curl, scripts, SDKs): allowed. An Origin must equal --allow-origin exactly. */
export function originAllowed(origin: string | undefined, allowOrigin?: string): boolean {
  if (origin === undefined) return true;
  return !!allowOrigin && origin === allowOrigin;
}

const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest();

/** "Authorization: Bearer <token>", compared in constant time (equal-length digests). */
export function tokenMatches(authorization: string | undefined, token: string): boolean {
  if (!authorization || !token) return false;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(authorization);
  const given = m ? m[1] : '';
  const ok = timingSafeEqual(digest(given), digest(token));
  return ok && given.length > 0;
}

/** At most `max` confirmed writes in any `windowMs` (default a minute). */
export class SendLimiter {
  private readonly times: number[] = [];
  constructor(readonly max: number, private readonly windowMs = 60_000, private readonly now: () => number = Date.now) {}

  /** Takes one slot, or says how many seconds until one frees up. */
  take(): { ok: true } | { ok: false; retryAfter: number } {
    const t = this.now();
    while (this.times.length && this.times[0] <= t - this.windowMs) this.times.shift();
    if (this.times.length >= this.max) return { ok: false, retryAfter: Math.max(1, Math.ceil((this.times[0] + this.windowMs - t) / 1000)) };
    this.times.push(t);
    return { ok: true };
  }
}
