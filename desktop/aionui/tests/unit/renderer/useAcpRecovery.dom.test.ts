/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { tokenUsageFromAcpUsage, useAcpMessage } from '@/renderer/pages/conversation/platforms/acp/useAcpMessage';
import { getConversationOrNull } from '@/renderer/pages/conversation/utils/conversationCache';
import { resetConversationTurnClockForTests } from '@/renderer/pages/conversation/utils/conversationTurnClock';
import { resetEnsureConversationRuntimeStateForTests } from '@/renderer/pages/conversation/utils/ensureConversationRuntime';
import type { IResponseMessage } from '@/common/adapter/ipcBridge';

const {
  addOrUpdateMessageMock,
  ensureRuntimeInvokeMock,
  getSlashCommandsInvokeMock,
  getUsageInvokeMock,
  responseStreamOnMock,
  responseStreamHandlerRef,
  clearSidebar,
  reconnectRef,
} = vi.hoisted(() => ({
  addOrUpdateMessageMock: vi.fn(),
  ensureRuntimeInvokeMock: vi.fn(),
  getSlashCommandsInvokeMock: vi.fn(),
  getUsageInvokeMock: vi.fn(),
  responseStreamOnMock: vi.fn(),
  clearSidebar: vi.fn(),
  reconnectRef: { current: undefined as (() => void) | undefined },
  responseStreamHandlerRef: {
    current: undefined as ((message: IResponseMessage) => void) | undefined,
  },
}));

vi.mock('@/renderer/pages/conversation/GroupedHistory/hooks/useConversationListSync', () => ({
  clearGeneratingAfterRecovery: clearSidebar,
}));

vi.mock('@/renderer/pages/conversation/Messages/hooks', () => ({
  useAddOrUpdateMessage: () => addOrUpdateMessageMock,
  useMergeLiveMessage: () => addOrUpdateMessageMock,
}));

vi.mock('@/renderer/pages/conversation/utils/conversationCache', () => ({
  getConversationOrNull: vi.fn(),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    acpConversation: {
      responseStream: {
        on: responseStreamOnMock.mockImplementation((handler: (message: IResponseMessage) => void) => {
          responseStreamHandlerRef.current = handler;
          return vi.fn();
        }),
      },
    },
    realtime: {
      reconnected: {
        on: (fn: () => void) => {
          reconnectRef.current = fn;
          return () => {};
        },
      },
    },
    conversation: {
      ensureRuntime: {
        invoke: ensureRuntimeInvokeMock,
      },
      getSlashCommands: {
        invoke: getSlashCommandsInvokeMock,
      },
      getUsage: {
        invoke: getUsageInvokeMock,
      },
    },
  },
}));

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('missed ACP stream recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    getUsageInvokeMock.mockResolvedValue(null);
    getSlashCommandsInvokeMock.mockResolvedValue([]);
  });
  const idle = {
    runtime: {
      is_processing: false,
      state: 'idle',
      can_send_message: true,
      has_task: false,
      turn_id: null,
      pending_confirmations: 0,
      supports_midturn_delivery: false,
    },
  } as never;
  it.each(['initial', 'terminal'])('recovers a completed turn after missing %s events', async (kind) => {
    const recovery = vi.fn();
    vi.mocked(getConversationOrNull).mockResolvedValue(idle);
    const id = 'lost-' + kind;
    const { result, unmount } = renderHook(() => useAcpMessage(id, { skipWarmup: true, onRecovery: recovery }));
    await act(async () => {
      await Promise.resolve();
    });
    if (kind === 'initial') act(() => result.current.setAiProcessing(true));
    else
      act(() =>
        responseStreamHandlerRef.current?.({
          type: 'start',
          data: null,
          msg_id: 'a',
          conversation_id: id,
          turn_id: 'turn-a',
        })
      );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(recovery).toHaveBeenCalledOnce();
    expect(clearSidebar).toHaveBeenCalledWith(id);
    expect(result.current.running || result.current.aiProcessing).toBe(false);
    unmount();
    vi.useRealTimers();
  });
  it('repairs a stale sidebar spinner after reopening an already idle conversation', async () => {
    const recovery = vi.fn();
    vi.mocked(getConversationOrNull).mockResolvedValue(idle);
    const { result, unmount } = renderHook(() =>
      useAcpMessage('idle-remount', { skipWarmup: true, onRecovery: recovery })
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.running).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(clearSidebar).toHaveBeenCalledWith('idle-remount');
    unmount();
    vi.useRealTimers();
  });
  it('reconciles immediately on reconnect', async () => {
    const recovery = vi.fn();
    vi.mocked(getConversationOrNull).mockResolvedValue(idle);
    const { result, unmount } = renderHook(() =>
      useAcpMessage('reconnect', { skipWarmup: true, onRecovery: recovery })
    );
    await act(async () => {
      await Promise.resolve();
    });
    act(() => result.current.setAiProcessing(true));
    await act(async () => {
      reconnectRef.current?.();
      await Promise.resolve();
    });
    expect(recovery).toHaveBeenCalledOnce();
    expect(result.current.aiProcessing).toBe(false);
    unmount();
    vi.useRealTimers();
  });
  it('ignores an old idle snapshot after a newer turn starts', async () => {
    const recovery = vi.fn();
    const pending = deferred<never>();
    vi.mocked(getConversationOrNull).mockResolvedValueOnce(null).mockReturnValueOnce(pending.promise);
    const { result, unmount } = renderHook(() => useAcpMessage('race', { skipWarmup: true, onRecovery: recovery }));
    await act(async () => {
      await Promise.resolve();
    });
    act(() =>
      responseStreamHandlerRef.current?.({
        type: 'start',
        data: null,
        msg_id: 'a',
        conversation_id: 'race',
        turn_id: 'turn-a',
      })
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    act(() =>
      responseStreamHandlerRef.current?.({
        type: 'start',
        data: null,
        msg_id: 'b',
        conversation_id: 'race',
        turn_id: 'turn-b',
      })
    );
    await act(async () => {
      pending.resolve(idle);
      await Promise.resolve();
    });
    expect(recovery).not.toHaveBeenCalled();
    expect(clearSidebar).not.toHaveBeenCalled();
    expect(result.current.running).toBe(true);
    unmount();
    vi.useRealTimers();
  });
  it('keeps a committed page valid until a newer turn starts', async () => {
    let valid: (() => boolean) | undefined;
    const recovery = vi.fn((guard: () => boolean) => {
      valid = guard;
    });
    vi.mocked(getConversationOrNull).mockResolvedValue(idle);
    const { result, unmount } = renderHook(() =>
      useAcpMessage('commit-guard', { skipWarmup: true, onRecovery: recovery })
    );
    await act(async () => {
      await Promise.resolve();
    });
    act(() => result.current.setAiProcessing(true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(valid?.()).toBe(true);
    act(() =>
      responseStreamHandlerRef.current?.({
        type: 'start',
        data: null,
        msg_id: 'new',
        conversation_id: 'commit-guard',
        turn_id: 'new',
      })
    );
    expect(valid?.()).toBe(false);
    unmount();
    vi.useRealTimers();
  });
  it('keeps processing and retries when persisted messages cannot be loaded', async () => {
    const recovery = vi.fn().mockRejectedValueOnce(new Error('synthetic failure')).mockResolvedValueOnce(undefined);
    vi.mocked(getConversationOrNull).mockResolvedValue(idle);
    const { result, unmount } = renderHook(() => useAcpMessage('retry', { skipWarmup: true, onRecovery: recovery }));
    await act(async () => {
      await Promise.resolve();
    });
    act(() => result.current.setAiProcessing(true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(result.current.aiProcessing).toBe(true);
    expect(clearSidebar).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(result.current.aiProcessing).toBe(false);
    expect(clearSidebar).toHaveBeenCalledWith('retry');
    unmount();
    vi.useRealTimers();
  });
  it('does not clear a newer turn while message recovery is pending', async () => {
    const load = deferred<void>();
    const recovery = vi.fn(() => load.promise);
    vi.mocked(getConversationOrNull).mockResolvedValue(idle);
    const { result, unmount } = renderHook(() =>
      useAcpMessage('load-race', { skipWarmup: true, onRecovery: recovery })
    );
    await act(async () => {
      await Promise.resolve();
    });
    act(() => result.current.setAiProcessing(true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    act(() =>
      responseStreamHandlerRef.current?.({
        type: 'start',
        data: null,
        msg_id: 'b',
        conversation_id: 'load-race',
        turn_id: 'new',
      })
    );
    await act(async () => {
      load.resolve();
      await Promise.resolve();
    });
    expect(result.current.running).toBe(true);
    expect(clearSidebar).not.toHaveBeenCalled();
    unmount();
    vi.useRealTimers();
  });
});
