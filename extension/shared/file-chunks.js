export const DEFAULT_CHUNK_SIZE = 512 * 1024;

export function splitBase64IntoChunks(base64, chunkSize = DEFAULT_CHUNK_SIZE) {
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new Error("chunkSize must be a positive integer");
  }

  const value = String(base64 || "");
  const chunks = [];

  for (let start = 0; start < value.length; start += chunkSize) {
    chunks.push(value.slice(start, start + chunkSize));
  }

  return chunks;
}

export function joinBase64Chunks(chunks) {
  return Array.isArray(chunks) ? chunks.join("") : "";
}
