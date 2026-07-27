/**
 * Fixed-window request limiter, keyed by client address.
 *
 * This is a blunt instrument on purpose: it exists so a looping script or a
 * misconfigured monitor cannot pin the box, not to defend against a determined
 * attacker. A single-writer SQLite app has no headroom to spare, and the cost
 * of being wrong here is only a 429 on a retry.
 */

/** Ceiling on tracked keys, so a wide address range cannot grow the map forever. */
const MAX_TRACKED = 5000;

export function createRateLimiter({ perMinute = 300, windowMs = 60_000 } = {}) {
  const windows = new Map();

  function check(key) {
    if (perMinute <= 0) return { allowed: true, remaining: Infinity, retryAfter: 0 };

    const now = Date.now();
    let entry = windows.get(key);

    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      // Re-inserting moves the key to the end of the Map, which is what makes
      // the eviction below drop genuinely idle callers first.
      windows.delete(key);
      windows.set(key, entry);
      if (windows.size > MAX_TRACKED) evict(now);
    }

    entry.count += 1;
    if (entry.count > perMinute) {
      return {
        allowed: false,
        remaining: 0,
        retryAfter: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
      };
    }
    return { allowed: true, remaining: perMinute - entry.count, retryAfter: 0 };
  }

  /** Drops expired windows, then the least recently seen keys if still over. */
  function evict(now) {
    for (const [key, entry] of windows) {
      if (now >= entry.resetAt) windows.delete(key);
    }
    for (const key of windows.keys()) {
      if (windows.size <= MAX_TRACKED) break;
      windows.delete(key);
    }
  }

  return {
    check,
    reset: () => windows.clear(),
    get size() {
      return windows.size;
    },
  };
}
