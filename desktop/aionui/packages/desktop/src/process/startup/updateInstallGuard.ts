import { randomUUID } from 'node:crypto';
import type { UpdateInstallPreflight } from '../services/autoUpdaterService';

type GuardOptions = {
  port: number;
  running: boolean;
  isCurrent?: () => boolean;
  fetchImpl?: typeof fetch;
  createId?: () => string;
};

/** Reserve the same Core turn gate used by work creation. No renderer sees the local capability. */
export async function reserveUpdateInstall(options: GuardOptions): Promise<UpdateInstallPreflight> {
  if (!options.running || !Number.isInteger(options.port) || options.port < 1 || options.port > 65535)
    return { ok: false, reason: 'unavailable' };
  const id = (options.createId ?? randomUUID)();
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = `http://127.0.0.1:${options.port}`;
  const request = (operation: 'quiesce' | 'release') =>
    fetchImpl(`${base}/api/system/update/${operation}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reservation_id: id }),
      signal: AbortSignal.timeout(5000),
      redirect: 'error',
    });
  const release = async () => {
    const response = await request('release');
    if (!response.ok) throw new Error('Update reservation release failed.');
    const body = (await response.json()) as {
      success?: boolean;
      data?: { reservation_id?: string; reserved?: boolean };
    };
    if (body.success !== true || body.data?.reservation_id !== id || body.data.reserved !== false)
      throw new Error('Update reservation release was not confirmed.');
  };
  const retryRelease = () => {
    const timer = setTimeout(() => {
      if (options.isCurrent && !options.isCurrent()) return;
      void release().catch(retryRelease);
    }, 5000);
    timer.unref();
  };
  const rollback = async () => {
    try {
      await release();
    } catch (error) {
      retryRelease();
      throw error;
    }
  };
  try {
    const response = await request('quiesce');
    const body = (await response.json()) as {
      success?: boolean;
      code?: string;
      data?: { reservation_id?: string; reserved?: boolean };
    };
    if (response.status === 409 && body.code === 'UPDATE_ACTIVE_WORK') return { ok: false, reason: 'active' };
    if (response.status === 409 && body.code === 'UPDATE_OPEN_RUNTIMES') return { ok: false, reason: 'open' };
    if (!response.ok || body.success !== true || body.data?.reservation_id !== id || body.data.reserved !== true)
      throw new Error('Update reservation was not confirmed.');
    return { ok: true, rollback };
  } catch {
    // A lost response could hide a committed reservation. Core records a
    // tombstone for this id, fencing even a late-arriving quiesce request.
    await rollback().catch(() => {});
    return { ok: false, reason: 'unavailable' };
  }
}
