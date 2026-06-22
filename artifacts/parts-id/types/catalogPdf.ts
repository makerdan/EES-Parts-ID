export type ResumeProgress = {
  status: "uploading" | "processing" | "done" | "failed";
  processedPages: number;
  totalPages: number | null;
  matchedParts: number;
  errorMessage: string | null;
  chunkIndex?: number;
  totalChunks?: number;
};
