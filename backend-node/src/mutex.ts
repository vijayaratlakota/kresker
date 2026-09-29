/**
 * An asynchronous mutex.
 *
 * Node runs JavaScript on one thread, so plain synchronous code never needs a lock. What
 * can still interleave is a sequence of steps that AWAITS in the middle — a GPU boot
 * that waits minutes for AWS, say — while another request starts the same sequence.
 * Python guarded those with threading locks; this is the same guarantee for code that
 * yields: callers run one at a time, in arrival order.
 */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();
  private held = false;

  /** Is somebody inside right now? */
  get locked(): boolean {
    return this.held;
  }

  /** Run `fn` with the lock held, releasing it however `fn` ends. */
  async run<T>(fn: () => Promise<T> | T): Promise<T> {
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    const prev = this.tail;
    this.tail = prev.then(() => next);
    await prev;
    this.held = true;
    try {
      return await fn();
    } finally {
      this.held = false;
      release();
    }
  }
}
