export class RateLimiter {
  private timestamps: number[] = [];

  constructor(
    private maxRequests: number = 100,
    private windowMs: number = 120_000 // 2 minutes
  ) {}

  async acquire(): Promise<void> {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => now - t < this.windowMs);

    if (this.timestamps.length >= this.maxRequests) {
      const waitMs = this.timestamps[0] + this.windowMs - now;
      console.error(`Rate limit: waiting ${waitMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      this.timestamps = this.timestamps.filter(
        (t) => Date.now() - t < this.windowMs
      );
    }

    this.timestamps.push(Date.now());
  }
}
