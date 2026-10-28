/** Bounded public-preview provider budget. Paid requests never use this queue/cache. */
export class PreviewBudget {
  private cache = new Map<string, { value: unknown; until: number }>();
  private inFlight = new Map<string, Promise<any>>();
  private windowStart = 0;
  private starts = 0;
  constructor(private clock = Date.now, private maxConcurrent = 4, private maxStartsPerMinute = 60, private ttlMs = 5_000, private maxEntries = 128) {}
  async acquire<T>(key: string, work: () => Promise<T>): Promise<T> {
    const now = this.clock();
    const cached = this.cache.get(key);
    if (cached && cached.until > now) return structuredClone(cached.value) as T;
    if (cached) this.cache.delete(key);
    const pending = this.inFlight.get(key);
    if (pending) return structuredClone(await pending) as T;
    if (now - this.windowStart >= 60_000) { this.windowStart = now; this.starts = 0; }
    if (this.inFlight.size >= this.maxConcurrent || this.starts >= this.maxStartsPerMinute) throw new Error("PREVIEW_BUDGET_EXHAUSTED");
    this.starts++;
    const execution = Promise.resolve().then(work);
    this.inFlight.set(key, execution);
    try {
      const value = await execution;
      // Do not refresh acquisition timestamps or cache provider failures.
      this.cache.set(key, { value: structuredClone(value), until: this.clock() + this.ttlMs });
      while (this.cache.size > this.maxEntries) this.cache.delete(this.cache.keys().next().value!);
      return value;
    } finally { this.inFlight.delete(key); }
  }
}
