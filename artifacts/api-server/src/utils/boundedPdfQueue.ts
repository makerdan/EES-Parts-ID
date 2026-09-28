/** FIFO ownership of queued PDF buffers. Active jobs are owned by the worker. */
export function createBoundedPdfQueue<T extends { pdfBuffer: Buffer }>(maxJobs: number, maxBytes: number) {
  const pending: Array<T> = [];
  let bytes = 0;
  return {
    get length() { return pending.length; },
    get bytes() { return bytes; },
    enqueue(job: T): boolean {
      if (pending.length >= maxJobs || bytes + job.pdfBuffer.length > maxBytes) return false;
      pending.push(job);
      bytes += job.pdfBuffer.length;
      return true;
    },
    take(): T | undefined {
      const job = pending.shift();
      if (job) bytes -= job.pdfBuffer.length;
      return job;
    },
  };
}