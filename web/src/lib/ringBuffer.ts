/** Fixed-capacity FIFO: once full, each push overwrites the oldest item. */
export class RingBuffer<T> {
  readonly capacity: number;
  readonly #items: (T | undefined)[];
  #start = 0;
  #size = 0;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`RingBuffer capacity must be a positive integer, got ${capacity}`);
    }
    this.capacity = capacity;
    this.#items = new Array<T | undefined>(capacity);
  }

  get size(): number {
    return this.#size;
  }

  push(item: T): void {
    this.#items[(this.#start + this.#size) % this.capacity] = item;
    if (this.#size < this.capacity) {
      this.#size++;
    } else {
      this.#start = (this.#start + 1) % this.capacity;
    }
  }

  /** The most recently pushed item. */
  last(): T | undefined {
    return this.#size === 0
      ? undefined
      : this.#items[(this.#start + this.#size - 1) % this.capacity];
  }

  /** Items from oldest to newest. */
  toArray(): T[] {
    const out: T[] = [];
    for (let i = 0; i < this.#size; i++) {
      out.push(this.#items[(this.#start + i) % this.capacity] as T);
    }
    return out;
  }

  clear(): void {
    this.#items.fill(undefined);
    this.#start = 0;
    this.#size = 0;
  }
}
