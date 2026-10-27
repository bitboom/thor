const MAX_PDF_PREVIEW_BYTES = 64 * 1024 * 1024;

/** Fetch via the trusted renderer; the guest receives only document bytes, never Core credentials. */
export async function fetchPdfPreviewBlob(url: string, signal: AbortSignal): Promise<Blob> {
  const response = await fetch(url, { signal });
  if (!response.ok || !response.body) throw new Error('PDF preview unavailable');
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_PDF_PREVIEW_BYTES) throw new Error('PDF preview is too large');
  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let total = 0;
  try {
    while (true) {
      // Stream reads must stay sequential to enforce the byte limit before buffering more.
      // eslint-disable-next-line no-await-in-loop
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_PDF_PREVIEW_BYTES) throw new Error('PDF preview is too large');
      chunks.push(new Uint8Array(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  return new Blob(chunks, { type: 'application/pdf' });
}
