/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { type PropsWithChildren } from 'react';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcBridge } from '@/common';
import {
  localSendStarted,
  conversationDeleted,
} from '@/renderer/pages/conversation/runtime/conversationRuntimeViewStore';
import type { IMessageAcpToolCall, IMessageText, IMessageThinking } from '@/common/chat/chatLib';
import {
  MessageListLoadingProvider,
  MessageListProvider,
  MessagePaginationProvider,
  useAddOrUpdateMessage,
  useMessageLstCache,
  useMessageList,
  useMessagePaginationState,
  useLoadPreviousMessagePage,
  useReplaceWithAnchorWindow,
} from '@/renderer/pages/conversation/Messages/hooks';

vi.mock('@/common', () => ({
  ipcBridge: {
    conversation: {
      userCreated: {
        on: vi.fn().mockReturnValue(() => {}),
      },
      statusChanged: {
        on: vi.fn().mockReturnValue(() => {}),
      },
      turnCompleted: {
        on: vi.fn().mockReturnValue(() => {}),
      },
    },
    database: {
      getConversationMessages: {
        invoke: vi.fn(),
      },
    },
  },
}));

const CONVERSATION_ID = 'conversation-1';

function createTextMessage(msgId: string, content: string): IMessageText {
  return {
    id: `text-${msgId}-${content}`,
    type: 'text',
    msg_id: msgId,
    conversation_id: CONVERSATION_ID,
    position: 'left',
    content: {
      content,
    },
  };
}

function createThinkingMessage(msgId: string, content: string): IMessageThinking {
  return {
    id: `thinking-${msgId}-${content}`,
    type: 'thinking',
    msg_id: msgId,
    conversation_id: CONVERSATION_ID,
    position: 'left',
    content: {
      content,
      status: 'thinking',
    },
  };
}

function createThinkingDoneMessage(msgId: string, duration: number): IMessageThinking {
  return {
    id: `thinking-done-${msgId}`,
    type: 'thinking',
    msg_id: msgId,
    conversation_id: CONVERSATION_ID,
    position: 'left',
    content: {
      content: '',
      duration,
      status: 'done',
    },
  };
}

function createToolCallMessage(toolCallId: string): IMessageAcpToolCall {
  return {
    id: toolCallId,
    type: 'acp_tool_call',
    msg_id: toolCallId,
    conversation_id: CONVERSATION_ID,
    position: 'left',
    content: {
      session_id: 'session-1',
      update: {
        sessionUpdate: 'tool_call',
        tool_call_id: toolCallId,
        status: 'completed',
        title: 'Read file',
        kind: 'read',
      },
    },
  };
}

function TestWrapper({ children }: PropsWithChildren): JSX.Element {
  return <MessageListProvider value={[]}>{children}</MessageListProvider>;
}

function CacheWrapper({ children }: PropsWithChildren): JSX.Element {
  return (
    <MessageListLoadingProvider value={false}>
      <MessagePaginationProvider
        value={{ hasMoreBefore: false, hasMoreAfter: false, isLoadingBefore: false, isLoadingAnchor: false }}
      >
        <MessageListProvider value={[]}>{children}</MessageListProvider>
      </MessagePaginationProvider>
    </MessageListLoadingProvider>
  );
}

function useMessageHarness() {
  return {
    addOrUpdateMessage: useAddOrUpdateMessage(),
    messages: useMessageList(),
  };
}

function useAnchorMessageHarness() {
  return {
    addOrUpdateMessage: useAddOrUpdateMessage(),
    replaceWithAnchorWindow: useReplaceWithAnchorWindow(),
    messages: useMessageList(),
  };
}

async function flushMessageQueue(): Promise<void> {
  await act(async () => {
    vi.runAllTimers();
  });
}

describe('message merging', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('keeps text segments split when tool calls interrupt the same msg_id stream', async () => {
    const { result } = renderHook(() => useMessageHarness(), {
      wrapper: TestWrapper,
    });

    act(() => {
      result.current.addOrUpdateMessage(createTextMessage('msg-1', 'hello'));
      result.current.addOrUpdateMessage(createTextMessage('msg-1', ' world'));
    });
    await flushMessageQueue();

    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].type).toBe('text');
    expect((result.current.messages[0] as IMessageText).content.content).toBe('hello world');

    act(() => {
      result.current.addOrUpdateMessage(createToolCallMessage('tool-1'));
      result.current.addOrUpdateMessage(createTextMessage('msg-1', 'again'));
    });
    await flushMessageQueue();

    expect(result.current.messages.map((message) => message.type)).toEqual(['text', 'acp_tool_call', 'text']);
    expect((result.current.messages[0] as IMessageText).content.content).toBe('hello world');
    expect((result.current.messages[2] as IMessageText).content.content).toBe('again');
  });

  it('keeps thinking segments split when tool calls interrupt the same msg_id stream', async () => {
    const { result } = renderHook(() => useMessageHarness(), {
      wrapper: TestWrapper,
    });

    act(() => {
      result.current.addOrUpdateMessage(createThinkingMessage('msg-1', 'alpha'));
      result.current.addOrUpdateMessage(createThinkingMessage('msg-1', 'beta'));
    });
    await flushMessageQueue();

    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].type).toBe('thinking');
    expect((result.current.messages[0] as IMessageThinking).content.content).toBe('alphabeta');

    act(() => {
      result.current.addOrUpdateMessage(createToolCallMessage('tool-1'));
      result.current.addOrUpdateMessage(createThinkingMessage('msg-1', 'gamma'));
    });
    await flushMessageQueue();

    expect(result.current.messages.map((message) => message.type)).toEqual(['thinking', 'acp_tool_call', 'thinking']);
    expect((result.current.messages[0] as IMessageThinking).content.content).toBe('alphabeta');
    expect((result.current.messages[2] as IMessageThinking).content.content).toBe('gamma');
  });

  it('merges thinking done updates into the existing thinking message instead of appending a completion message', async () => {
    const { result } = renderHook(() => useMessageHarness(), {
      wrapper: TestWrapper,
    });

    act(() => {
      result.current.addOrUpdateMessage(createThinkingMessage('msg-1', 'alpha'));
      result.current.addOrUpdateMessage(createToolCallMessage('tool-1'));
      result.current.addOrUpdateMessage(createThinkingDoneMessage('msg-1', 4200));
    });
    await flushMessageQueue();

    expect(result.current.messages.map((message) => message.type)).toEqual(['thinking', 'acp_tool_call']);
    expect((result.current.messages[0] as IMessageThinking).content.status).toBe('done');
    expect((result.current.messages[0] as IMessageThinking).content.duration).toBe(4200);
  });

  it('ignores non-renderable transformed stream messages', async () => {
    const { result } = renderHook(() => useMessageHarness(), {
      wrapper: TestWrapper,
    });

    act(() => {
      result.current.addOrUpdateMessage(undefined);
    });
    await flushMessageQueue();

    expect(result.current.messages).toEqual([]);
  });

  it('keeps live-only and richer streaming messages when replacing with an anchor window', async () => {
    const { result } = renderHook(() => useAnchorMessageHarness(), {
      wrapper: TestWrapper,
    });

    act(() => {
      result.current.addOrUpdateMessage(createTextMessage('agent-1', 'partial streaming response'));
      result.current.addOrUpdateMessage(createTextMessage('agent-2', 'live tail'));
    });
    await flushMessageQueue();

    act(() => {
      result.current.replaceWithAnchorWindow(CONVERSATION_ID, [
        createTextMessage('user-anchor', 'anchor'),
        createTextMessage('agent-1', 'partial'),
      ]);
    });

    expect(result.current.messages.map((message) => message.msg_id)).toEqual(['user-anchor', 'agent-1', 'agent-2']);
    expect((result.current.messages[1] as IMessageText).content.content).toBe('partial streaming response');
    expect((result.current.messages[2] as IMessageText).content.content).toBe('live tail');
  });

  it('requests compact tool content when hydrating historical messages', async () => {
    const invoke = vi.mocked(ipcBridge.database.getConversationMessages.invoke);
    invoke.mockClear();
    invoke.mockResolvedValue({
      items: [],
      oldest_cursor: null,
      newest_cursor: null,
      has_more_before: false,
      has_more_after: false,
    });

    renderHook(() => useMessageLstCache(CONVERSATION_ID), {
      wrapper: CacheWrapper,
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(invoke).toHaveBeenCalledWith({
      conversation_id: CONVERSATION_ID,
      limit: 50,
      content_mode: 'compact',
    });
  });

  it('flips a pending user message to finish when message.statusChanged arrives for it', async () => {
    const invoke = vi.mocked(ipcBridge.database.getConversationMessages.invoke);
    invoke.mockResolvedValue({
      items: [],
      oldest_cursor: null,
      newest_cursor: null,
      has_more_before: false,
      has_more_after: false,
    });

    let emitUserCreated: ((payload: any) => void) | undefined;
    let emitStatusChanged: ((payload: any) => void) | undefined;
    vi.mocked(ipcBridge.conversation.userCreated.on).mockImplementation((cb: any) => {
      emitUserCreated = cb;
      return () => {};
    });
    vi.mocked(ipcBridge.conversation.statusChanged.on).mockImplementation((cb: any) => {
      emitStatusChanged = cb;
      return () => {};
    });

    function useCacheAndListHarness() {
      useMessageLstCache(CONVERSATION_ID);
      return { messages: useMessageList() };
    }

    const { result } = renderHook(() => useCacheAndListHarness(), { wrapper: CacheWrapper });

    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      emitUserCreated?.({
        conversation_id: CONVERSATION_ID,
        msg_id: 'msg-midturn-1',
        client_msg_id: 'client-1',
        content: 'sent mid-turn',
        position: 'right',
        status: 'pending',
        hidden: false,
        created_at: Date.now(),
      });
    });

    expect(
      (result.current.messages.find((m) => m.msg_id === 'msg-midturn-1') as IMessageText | undefined)?.status
    ).toBe('pending');

    act(() => {
      emitStatusChanged?.({
        user_id: 'user-1',
        conversation_id: CONVERSATION_ID,
        msg_id: 'msg-midturn-1',
        status: 'finish',
      });
    });

    expect(
      (result.current.messages.find((m) => m.msg_id === 'msg-midturn-1') as IMessageText | undefined)?.status
    ).toBe('finish');
  });

  it('ignores message.statusChanged for a different conversation', async () => {
    const invoke = vi.mocked(ipcBridge.database.getConversationMessages.invoke);
    invoke.mockResolvedValue({
      items: [],
      oldest_cursor: null,
      newest_cursor: null,
      has_more_before: false,
      has_more_after: false,
    });

    let emitUserCreated: ((payload: any) => void) | undefined;
    let emitStatusChanged: ((payload: any) => void) | undefined;
    vi.mocked(ipcBridge.conversation.userCreated.on).mockImplementation((cb: any) => {
      emitUserCreated = cb;
      return () => {};
    });
    vi.mocked(ipcBridge.conversation.statusChanged.on).mockImplementation((cb: any) => {
      emitStatusChanged = cb;
      return () => {};
    });

    function useCacheAndListHarness() {
      useMessageLstCache(CONVERSATION_ID);
      return { messages: useMessageList() };
    }

    const { result } = renderHook(() => useCacheAndListHarness(), { wrapper: CacheWrapper });

    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      emitUserCreated?.({
        conversation_id: CONVERSATION_ID,
        msg_id: 'msg-midturn-2',
        content: 'sent mid-turn',
        position: 'right',
        status: 'pending',
        hidden: false,
        created_at: Date.now(),
      });
    });

    act(() => {
      emitStatusChanged?.({
        user_id: 'user-1',
        conversation_id: 'other-conversation',
        msg_id: 'msg-midturn-2',
        status: 'finish',
      });
    });

    expect(
      (result.current.messages.find((m) => m.msg_id === 'msg-midturn-2') as IMessageText | undefined)?.status
    ).toBe('pending');
  });

  it('reconciles a pending badge with the DB row when a turn completes for this conversation', async () => {
    const invoke = vi.mocked(ipcBridge.database.getConversationMessages.invoke);
    invoke.mockResolvedValueOnce({
      items: [],
      oldest_cursor: null,
      newest_cursor: null,
      has_more_before: false,
      has_more_after: false,
    });

    let emitUserCreated: ((payload: any) => void) | undefined;
    let emitTurnCompleted: ((payload: any) => void) | undefined;
    vi.mocked(ipcBridge.conversation.userCreated.on).mockImplementation((cb: any) => {
      emitUserCreated = cb;
      return () => {};
    });
    vi.mocked(ipcBridge.conversation.turnCompleted.on).mockImplementation((cb: any) => {
      emitTurnCompleted = cb;
      return () => {};
    });

    function useCacheAndListHarness() {
      useMessageLstCache(CONVERSATION_ID);
      return { messages: useMessageList() };
    }

    const { result } = renderHook(() => useCacheAndListHarness(), { wrapper: CacheWrapper });

    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      emitUserCreated?.({
        conversation_id: CONVERSATION_ID,
        msg_id: 'msg-midturn-3',
        content: 'sent mid-turn',
        position: 'right',
        status: 'pending',
        hidden: false,
        created_at: Date.now(),
      });
    });

    expect(
      (result.current.messages.find((m) => m.msg_id === 'msg-midturn-3') as IMessageText | undefined)?.status
    ).toBe('pending');

    // The reconcile reload returns the DB's authoritative 'finish' row — the
    // missed live statusChanged event never arrived, so this is the only
    // path that heals the badge.
    invoke.mockResolvedValueOnce({
      items: [
        {
          id: 'msg-midturn-3',
          msg_id: 'msg-midturn-3',
          conversation_id: CONVERSATION_ID,
          type: 'text',
          position: 'right',
          status: 'finish',
          hidden: false,
          created_at: Date.now(),
          content: { content: 'sent mid-turn' },
        },
      ],
      oldest_cursor: null,
      newest_cursor: null,
      has_more_before: false,
      has_more_after: false,
    });

    invoke.mockClear();

    act(() => {
      emitTurnCompleted?.({ session_id: CONVERSATION_ID, turn_id: 'turn-1' });
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(invoke).toHaveBeenCalled();
    expect(
      (result.current.messages.find((m) => m.msg_id === 'msg-midturn-3') as IMessageText | undefined)?.status
    ).toBe('finish');
  });

  it('loads persisted assistant output on turnCompleted even without a pending user row', async () => {
    const invoke = vi.mocked(ipcBridge.database.getConversationMessages.invoke);
    invoke.mockResolvedValue({
      items: [],
      oldest_cursor: null,
      newest_cursor: null,
      has_more_before: false,
      has_more_after: false,
    });

    let emitTurnCompleted: ((payload: any) => void) | undefined;
    vi.mocked(ipcBridge.conversation.turnCompleted.on).mockImplementation((cb: any) => {
      emitTurnCompleted = cb;
      return () => {};
    });

    const { result } = renderHook(
      () => {
        useMessageLstCache(CONVERSATION_ID);
        return useMessageList();
      },
      { wrapper: CacheWrapper }
    );

    await act(async () => {
      await Promise.resolve();
    });

    invoke.mockResolvedValueOnce({
      items: [
        {
          id: 'answer',
          msg_id: 'answer',
          conversation_id: CONVERSATION_ID,
          type: 'text',
          position: 'left',
          status: 'finish',
          hidden: false,
          created_at: Date.now(),
          content: { content: 'persisted answer' },
        },
      ],
      oldest_cursor: null,
      newest_cursor: null,
      has_more_before: false,
      has_more_after: false,
    });
    invoke.mockClear();

    act(() => {
      emitTurnCompleted?.({ session_id: CONVERSATION_ID, turn_id: 'turn-1' });
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(invoke).toHaveBeenCalled();
    expect(result.current.some((message) => message.msg_id === 'answer')).toBe(true);
  });

  it('does not start a completion reload after the chat unmounts', async () => {
    const invoke = vi.mocked(ipcBridge.database.getConversationMessages.invoke);
    invoke.mockResolvedValue({
      items: [],
      oldest_cursor: null,
      newest_cursor: null,
      has_more_before: false,
      has_more_after: false,
    });
    let finish: ((payload: any) => void) | undefined;
    vi.mocked(ipcBridge.conversation.turnCompleted.on).mockImplementation((fn: any) => {
      finish = fn;
      return () => {};
    });
    const { unmount } = renderHook(() => useMessageLstCache(CONVERSATION_ID), { wrapper: CacheWrapper });
    await act(async () => {
      await Promise.resolve();
    });
    invoke.mockClear();
    await act(async () => {
      finish?.({ session_id: CONVERSATION_ID, turn_id: 'old' });
      unmount();
      await Promise.resolve();
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('does not apply a delayed turn-completion page after a new send', async () => {
    const invoke = vi.mocked(ipcBridge.database.getConversationMessages.invoke);
    const initial = {
      items: [],
      oldest_cursor: 'initial',
      newest_cursor: 'initial',
      has_more_before: true,
      has_more_after: false,
    };
    invoke.mockResolvedValueOnce(initial);
    let resolvePage!: (value: any) => void;
    invoke.mockReturnValueOnce(
      new Promise<any>((resolve) => {
        resolvePage = resolve;
      })
    );
    let finish: ((payload: any) => void) | undefined;
    vi.mocked(ipcBridge.conversation.turnCompleted.on).mockImplementation((fn: any) => {
      finish = fn;
      return () => {};
    });
    const { result } = renderHook(
      () => ({
        reload: useMessageLstCache(CONVERSATION_ID),
        messages: useMessageList(),
        pagination: useMessagePaginationState(),
      }),
      { wrapper: CacheWrapper }
    );
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      finish?.({ session_id: CONVERSATION_ID, turn_id: 'old' });
      await Promise.resolve();
    });
    act(() => {
      localSendStarted(CONVERSATION_ID);
    });
    await act(async () => {
      resolvePage({
        ...initial,
        oldest_cursor: 'stale',
        items: [
          {
            id: 'stale',
            msg_id: 'stale',
            conversation_id: CONVERSATION_ID,
            type: 'text',
            position: 'left',
            content: { content: 'stale' },
          },
        ],
      });
      await Promise.resolve();
    });
    expect(result.current.messages).toEqual([]);
    expect(result.current.pagination.oldestCursor).toBe('initial');
    conversationDeleted(CONVERSATION_ID);
  });

  it('does not apply a delayed recovery page after the turn changes', async () => {
    const invoke = vi.mocked(ipcBridge.database.getConversationMessages.invoke);
    const initial = {
      items: [],
      oldest_cursor: 'initial',
      newest_cursor: 'initial',
      has_more_before: true,
      has_more_after: false,
    };
    invoke.mockResolvedValueOnce(initial);
    let resolvePage!: (value: any) => void;
    const delayed = new Promise<any>((resolve) => {
      resolvePage = resolve;
    });
    invoke.mockReturnValueOnce(delayed);
    const { result } = renderHook(
      () => ({
        reload: useMessageLstCache(CONVERSATION_ID),
        messages: useMessageList(),
        pagination: useMessagePaginationState(),
      }),
      { wrapper: CacheWrapper }
    );
    await act(async () => {
      await Promise.resolve();
    });
    let current = true;
    let pending!: Promise<unknown>;
    act(() => {
      pending = result.current.reload(() => current);
    });
    current = false;
    await act(async () => {
      resolvePage({
        ...initial,
        oldest_cursor: 'stale',
        items: [
          {
            id: 'stale',
            msg_id: 'stale',
            conversation_id: CONVERSATION_ID,
            type: 'text',
            position: 'left',
            content: { content: 'stale' },
          },
        ],
      });
      await pending;
    });
    expect(result.current.messages).toEqual([]);
    expect(result.current.pagination.oldestCursor).toBe('initial');
  });

  it('does not apply a delayed recovery page over a newly requested history page', async () => {
    const invoke = vi.mocked(ipcBridge.database.getConversationMessages.invoke);
    const initial = {
      items: [],
      oldest_cursor: 'initial',
      newest_cursor: 'initial',
      has_more_before: true,
      has_more_after: false,
    };
    invoke.mockResolvedValueOnce(initial);
    let resolveLatest!: (value: any) => void;
    let resolvePrevious!: (value: any) => void;
    invoke.mockReturnValueOnce(
      new Promise<any>((resolve) => {
        resolveLatest = resolve;
      })
    );
    invoke.mockReturnValueOnce(
      new Promise<any>((resolve) => {
        resolvePrevious = resolve;
      })
    );
    const { result } = renderHook(
      () => ({
        reload: useMessageLstCache(CONVERSATION_ID),
        messages: useMessageList(),
        pagination: useMessagePaginationState(),
        previous: useLoadPreviousMessagePage(CONVERSATION_ID),
      }),
      { wrapper: CacheWrapper }
    );
    await act(async () => {
      await Promise.resolve();
    });
    let latest!: Promise<unknown>;
    let previous!: Promise<unknown>;
    act(() => {
      latest = result.current.reload();
      previous = result.current.previous();
    });
    await act(async () => {
      resolveLatest({
        ...initial,
        oldest_cursor: 'stale',
        items: [
          {
            id: 'stale',
            msg_id: 'stale',
            conversation_id: CONVERSATION_ID,
            type: 'text',
            position: 'left',
            content: { content: 'stale' },
          },
        ],
      });
      await latest;
    });
    expect(result.current.messages).toEqual([]);
    expect(result.current.pagination.isLoadingBefore).toBe(true);
    await act(async () => {
      resolvePrevious({ ...initial, oldest_cursor: 'older' });
      await previous;
    });
    expect(result.current.pagination.oldestCursor).toBe('older');
  });

  it('ignores turnCompleted for a different conversation even with a pending row', async () => {
    const invoke = vi.mocked(ipcBridge.database.getConversationMessages.invoke);
    invoke.mockResolvedValue({
      items: [],
      oldest_cursor: null,
      newest_cursor: null,
      has_more_before: false,
      has_more_after: false,
    });

    let emitUserCreated: ((payload: any) => void) | undefined;
    let emitTurnCompleted: ((payload: any) => void) | undefined;
    vi.mocked(ipcBridge.conversation.userCreated.on).mockImplementation((cb: any) => {
      emitUserCreated = cb;
      return () => {};
    });
    vi.mocked(ipcBridge.conversation.turnCompleted.on).mockImplementation((cb: any) => {
      emitTurnCompleted = cb;
      return () => {};
    });

    function useCacheAndListHarness() {
      useMessageLstCache(CONVERSATION_ID);
      return { messages: useMessageList() };
    }

    renderHook(() => useCacheAndListHarness(), { wrapper: CacheWrapper });

    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      emitUserCreated?.({
        conversation_id: CONVERSATION_ID,
        msg_id: 'msg-midturn-4',
        content: 'sent mid-turn',
        position: 'right',
        status: 'pending',
        hidden: false,
        created_at: Date.now(),
      });
    });

    invoke.mockClear();

    act(() => {
      emitTurnCompleted?.({ session_id: 'other-conversation', turn_id: 'turn-1' });
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(invoke).not.toHaveBeenCalled();
  });
});
