/**
 * Phase 2.1 — durable job state for the PowerShell service.
 *
 * The service tracks long-running async jobs (mailbox creation, delegation)
 * with their progress and final results. Originally these lived in a plain
 * in-process Map. When Railway redeploys (or the container OOMs while a
 * 99-mailbox job is mid-flight), the Map is wiped — the worker that started
 * the job polls /status/<jobId> and gets 404, marks the tenant failed with
 * a misleading "Mailbox creation status unavailable" error.
 *
 * This module defines a minimal store abstraction with two implementations:
 *
 *   - MemoryJobStore: the legacy behavior. Default. Zero deploy risk.
 *   - RedisJobStore: persists each job under `ps:job:<jobId>`. Survives
 *     container restarts. Activated when JOB_STORE_BACKEND=redis is set.
 *
 * Behind a flag so we can roll out incrementally and roll back via env
 * var. Bug 6.7 + Phase 2.1 in BULLETPROOF_PLAN_DETAILED.md.
 */

const TTL_SECONDS = 60 * 60 * 24; // 24h — long enough for the longest legitimate run, short enough that stale jobs evict

class MemoryJobStore {
  constructor(name) {
    this.name = name;
    this.map = new Map();
  }
  async set(jobId, value) {
    this.map.set(jobId, value);
  }
  async get(jobId) {
    return this.map.get(jobId) || null;
  }
  /**
   * Read-modify-write. The mutator receives the current value (or null
   * for new jobs) and returns the new value. Memory implementation is
   * trivially atomic since JS is single-threaded; Redis implementation
   * uses WATCH/MULTI/EXEC.
   */
  async update(jobId, mutator) {
    const next = mutator(this.map.get(jobId) || null);
    this.map.set(jobId, next);
    return next;
  }
}

class RedisJobStore {
  /**
   * @param {string} name namespace ('mailbox-create', 'delegation', etc.)
   * @param {import('ioredis').Redis} redis ioredis client
   */
  constructor(name, redis) {
    this.name = name;
    this.redis = redis;
    this.prefix = `ps:job:${name}:`;
  }
  key(jobId) {
    return `${this.prefix}${jobId}`;
  }
  async set(jobId, value) {
    await this.redis.set(this.key(jobId), JSON.stringify(value), "EX", TTL_SECONDS);
  }
  async get(jobId) {
    const raw = await this.redis.get(this.key(jobId));
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  async update(jobId, mutator) {
    // Best-effort optimistic loop. WATCH the key, read, compute, MULTI/EXEC.
    // On contention retry up to 3x — collisions on a single jobId are rare
    // (only happens if two pollers race a write).
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const k = this.key(jobId);
      await this.redis.watch(k);
      const raw = await this.redis.get(k);
      let current = null;
      if (raw) {
        try {
          current = JSON.parse(raw);
        } catch {
          current = null;
        }
      }
      const next = mutator(current);
      const result = await this.redis
        .multi()
        .set(k, JSON.stringify(next), "EX", TTL_SECONDS)
        .exec();
      if (result !== null) return next; // EXEC succeeded
      // EXEC returned null → another writer touched the key. Loop and retry.
    }
    // Fallback: unconditional write. Loses the "no concurrent change" guarantee
    // but at this point the conflict has been observed three times — unlikely
    // to be transient; just take the latest mutator output.
    const next = mutator(await this.get(jobId));
    await this.set(jobId, next);
    return next;
  }
}

/**
 * Build the right store based on env. Caller passes a name (used as the
 * Redis namespace) and an optional ioredis client (only used when
 * JOB_STORE_BACKEND=redis).
 */
function makeJobStore(name, redisClient) {
  if (process.env.JOB_STORE_BACKEND === "redis") {
    if (!redisClient) {
      throw new Error("JOB_STORE_BACKEND=redis but no Redis client provided to makeJobStore");
    }
    console.log(`📦 [JobStore:${name}] Redis backend active (key prefix: ps:job:${name}:)`);
    return new RedisJobStore(name, redisClient);
  }
  console.log(`📦 [JobStore:${name}] Memory backend active (legacy; jobs lost on container restart)`);
  return new MemoryJobStore(name);
}

module.exports = { makeJobStore, MemoryJobStore, RedisJobStore };
