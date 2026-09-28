export type ResumeProgress = {
  status: "uploading" | "processing" | "done" | "done_with_errors" | "failed" | "stalled";
  processedPages: number;
  totalPages: number | null;
  matchedParts: number;
  errorMessage: string | null;
  chunkIndex?: number;
  totalChunks?: number;
};
