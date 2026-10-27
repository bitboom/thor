import { afterEach, describe, expect, it, vi } from 'vitest';
import { reserveUpdateInstall } from '@/process/startup/updateInstallGuard';
const id = '12345678-1234-4234-8234-123456789abc';
const opts = { port: 13400, running: true, createId: () => id };
const reply = (reserved: boolean) =>
  new Response(JSON.stringify({ success: true, data: { reservation_id: id, reserved } }), { status: 200 });
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});
describe('update installation Core reservation', () => {
  it('fails closed while Core is unavailable', async () => {
    const fetchImpl = vi.fn();
    expect(await reserveUpdateInstall({ ...opts, running: false, fetchImpl })).toEqual({
      ok: false,
      reason: 'unavailable',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('holds the acknowledged reservation and releases the same id on rollback', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(reply(true)).mockResolvedValueOnce(reply(false));
    const result = await reserveUpdateInstall({ ...opts, fetchImpl });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected reservation');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await result.rollback();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(
      fetchImpl.mock.calls.map((call) => [new URL(call[0]).pathname, JSON.parse(call[1].body).reservation_id])
    ).toEqual([
      ['/api/system/update/quiesce', id],
      ['/api/system/update/release', id],
    ]);
  });
  it('reports active work and never starts installation', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ code: 'UPDATE_ACTIVE_WORK' }), { status: 409 }));
    expect(await reserveUpdateInstall({ ...opts, fetchImpl })).toEqual({ ok: false, reason: 'active' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('separately reports open agent runtimes', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ code: 'UPDATE_OPEN_RUNTIMES' }), { status: 409 }));
    expect(await reserveUpdateInstall({ ...opts, fetchImpl })).toEqual({ ok: false, reason: 'open' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('tombstones a reservation after a lost or malformed response', async () => {
    await Promise.all(
      [new Error('connection lost'), new Response(JSON.stringify({ success: true, data: {} }))].map(async (outcome) => {
        const fetchImpl = vi.fn();
        if (outcome instanceof Error) fetchImpl.mockRejectedValueOnce(outcome);
        else fetchImpl.mockResolvedValueOnce(outcome);
        fetchImpl.mockResolvedValueOnce(reply(false));
        expect(await reserveUpdateInstall({ ...opts, fetchImpl })).toEqual({ ok: false, reason: 'unavailable' });
        expect(new URL(fetchImpl.mock.calls[1][0]).pathname).toBe('/api/system/update/release');
      })
    );
  });
  it('retries a failed rollback while the same Core process remains active', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(reply(true))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(reply(false));
    const result = await reserveUpdateInstall({ ...opts, fetchImpl, isCurrent: () => true });
    if (!result.ok) throw new Error('expected reservation');
    await expect(result.rollback()).rejects.toThrow('offline');
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
