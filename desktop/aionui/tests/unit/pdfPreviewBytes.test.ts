import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchPdfPreviewBlob } from '@/renderer/pages/conversation/Preview/components/viewers/pdfPreviewBytes';

afterEach(() => vi.unstubAllGlobals());
describe('bounded PDF preview bytes', () => {
  it('fetches document bytes in the trusted renderer and preserves their content', async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([37, 80, 68, 70])));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    const blob = await fetchPdfPreviewBlob('http://127.0.0.1:13400/api/fs/stream', controller.signal);
    expect(blob.type).toBe('application/pdf');
    expect(Array.from(new Uint8Array(await blob.arrayBuffer()))).toEqual([37, 80, 68, 70]);
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:13400/api/fs/stream', { signal: controller.signal });
  });
  it('rejects declared oversized content before reading it', async () => {
    const response = new Response('data', { headers: { 'content-length': String(64 * 1024 * 1024 + 1) } });
    const reader = vi.spyOn(response.body!, 'getReader');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response)
    );
    await expect(
      fetchPdfPreviewBlob('http://127.0.0.1:13400/api/fs/stream', new AbortController().signal)
    ).rejects.toThrow('too large');
    expect(reader).not.toHaveBeenCalled();
  });
  it('also stops oversized streams with no declared length', async () => {
    const cancel = vi.fn();
    let index = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index++ === 0) controller.enqueue(new Uint8Array(64 * 1024 * 1024));
        else controller.enqueue(new Uint8Array(1));
      },
      cancel,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body))
    );
    await expect(
      fetchPdfPreviewBlob('http://127.0.0.1:13400/api/fs/stream', new AbortController().signal)
    ).rejects.toThrow('too large');
    expect(cancel).toHaveBeenCalled();
  });
  it('rejects failed requests rather than passing an error page to the guest', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('denied', { status: 403 }))
    );
    await expect(
      fetchPdfPreviewBlob('http://127.0.0.1:13400/api/fs/stream', new AbortController().signal)
    ).rejects.toThrow('unavailable');
  });
});
