import { createBoundedPdfQueue } from "../utils/boundedPdfQueue";

describe("catalog PDF waiting queue", () => {
  it("bounds both queued jobs and bytes and releases capacity in FIFO order", () => {
    const queue = createBoundedPdfQueue<{ id: number; pdfBuffer: Buffer }>(2, 10);
    const first = { id: 1, pdfBuffer: Buffer.alloc(6) };
    const second = { id: 2, pdfBuffer: Buffer.alloc(4) };
    expect(queue.enqueue(first)).toBe(true);
    expect(queue.enqueue({ id: 3, pdfBuffer: Buffer.alloc(5) })).toBe(false);
    expect(queue.enqueue(second)).toBe(true);
    expect(queue.enqueue({ id: 4, pdfBuffer: Buffer.alloc(1) })).toBe(false);
    expect(queue.bytes).toBe(10);
    expect(queue.take()).toBe(first);
    expect(queue.bytes).toBe(4);
    expect(queue.enqueue({ id: 5, pdfBuffer: Buffer.alloc(6) })).toBe(true);
    expect(queue.take()).toBe(second);
    expect(queue.take()?.id).toBe(5);
    expect(queue.take()).toBeUndefined();
    expect(queue.length).toBe(0);
    expect(queue.bytes).toBe(0);
  });

  it("admits at most two simultaneous completion attempts while jobs are waiting", async () => {
    const queue = createBoundedPdfQueue<{ id: number; pdfBuffer: Buffer }>(2, 8);
    const accepted = await Promise.all(Array.from({ length: 12 }, (_, id) =>
      Promise.resolve().then(() => queue.enqueue({ id, pdfBuffer: Buffer.alloc(4) })),
    ));
    expect(accepted.filter(Boolean)).toHaveLength(2);
    expect(queue.length).toBe(2);
    expect(queue.bytes).toBe(8);
    expect(queue.take()?.id).toBe(0);
    expect(queue.enqueue({ id: 12, pdfBuffer: Buffer.alloc(4) })).toBe(true);
    expect(queue.take()?.id).toBe(1);
    expect(queue.take()?.id).toBe(12);
    expect(queue.bytes).toBe(0);
  });
});