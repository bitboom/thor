import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '/test-user-data') } }));
vi.mock('@process/utils/initStorage', () => ({ getSystemDir: vi.fn() }));
vi.mock('@/common/adapter/httpBridge', () => ({ httpRequest: vi.fn() }));
vi.mock('@aionui/web-host', () => ({ startWebHost: vi.fn() }));
vi.mock('@process/utils/utils', () => ({ getDataPath: vi.fn() }));

import { httpRequest } from '@/common/adapter/httpBridge';
import { startWebHost } from '@aionui/web-host';
import { restoreDesktopWebUIFromPreferences, startDesktopWebUI } from '@process/utils/webuiConfig';

describe('desktop WebUI local Core gate', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects browser proxy startup before spawning or changing local credentials', async () => {
    await expect(startDesktopWebUI({ allowRemote: true })).rejects.toThrow('separate Core in WebUI mode');
    expect(startWebHost).not.toHaveBeenCalled();
    expect(httpRequest).not.toHaveBeenCalled();
  });

  it('reconciles an old automatic-start preference without opening a listener', async () => {
    vi.mocked(httpRequest).mockResolvedValueOnce({ 'webui.desktop.enabled': true });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await restoreDesktopWebUIFromPreferences();
      expect(startWebHost).not.toHaveBeenCalled();
      expect(httpRequest).toHaveBeenCalledWith('PUT', '/api/settings/client', { 'webui.desktop.enabled': false });
    } finally {
      error.mockRestore();
    }
  });
});
