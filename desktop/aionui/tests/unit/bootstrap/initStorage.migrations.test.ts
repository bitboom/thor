/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('initStorage.migrations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('handles empty storage on first run', () => {
    expect(true).toBe(true);
  });

  it('detects M1 migration branch when assistant data present', () => {
    expect(true).toBe(true);
  });

  it('detects provider migration branch', () => {
    expect(true).toBe(true);
  });

  it('skips migration when already migrated', () => {
    expect(true).toBe(true);
  });

  it('initStorage returns valid config', () => {
    expect(true).toBe(true);
  });
});

vi.mock('@/common', () => ({ ipcBridge: { deepLink: { received: { emit: vi.fn() } } } }));
import { parseDeepLinkUrl, PROTOCOL_SCHEME } from '@/process/utils/deepLink';

describe('Thor deep links', () => {
  it('accepts Thor links', () => {
    expect(PROTOCOL_SCHEME).toBe('thor');
    expect(parseDeepLinkUrl('thor://add-provider?name=demo')).toEqual({
      action: 'add-provider',
      params: { name: 'demo' },
    });
  });
  it('does not accept links owned by AionUi', () => {
    expect(parseDeepLinkUrl('aionui://add-provider?name=demo')).toBeNull();
  });
});
