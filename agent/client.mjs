/** Headless client operations against the same AionCore API used by the desktop. */
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const route = id => `/api/conversations/${encodeURIComponent(id)}`;

export function messageText(message) {
  return typeof message.content === 'string' ? message.content : typeof message.content?.content === 'string' ? message.content.content : JSON.stringify(message.content);
}

export async function waitForCoreIdle(api, conversationId, { timeoutMs = 120000, pollMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { data } = await api.get(route(conversationId));
    if (data.runtime?.state === 'waiting_confirmation' || data.runtime?.pending_confirmations > 0) throw new Error('Core turn requires an explicit user confirmation.');
    if (data.runtime?.state === 'idle' && !data.runtime.is_processing && data.runtime.can_send_message) return data;
    await pause(pollMs);
  }
  throw new Error('Core turn did not become idle before the deadline.');
}

export async function runCoreTurn(api, { conversationId, content, timeoutMs = 120000 }) {
  const before = (await api.get(`${route(conversationId)}/messages?limit=100`)).data.items;
  const previousIds = new Set(before.map(message => message.id));
  const sent = (await api.post(`${route(conversationId)}/messages`, { content })).data;
  const conversation = await waitForCoreIdle(api, conversationId, { timeoutMs });
  const messages = (await api.get(`${route(conversationId)}/messages?limit=100`)).data.items.filter(message => !previousIds.has(message.id));
  const errors = messages.filter(message => message.status === 'error');
  if (errors.length) throw new Error(`Core turn produced ${errors.length} error message(s); inspect local diagnostics.`);
  const assistantMessages = messages.filter(message => message.type === 'text' && message.position === 'left' && message.status === 'finish');
  if (!assistantMessages.length) throw new Error('Core became idle without a completed assistant response.');
  return { conversation, turnId: sent.turn_id, messages, assistantText: assistantMessages.map(messageText).join('\n') };
}

export async function cancelCoreTurn(api, { conversationId, content, timeoutMs = 30000 }) {
  const sent = (await api.post(`${route(conversationId)}/messages`, { content })).data;
  await pause(100);
  const cancellation = (await api.post(`${route(conversationId)}/cancel`, { turn_id: sent.turn_id })).data;
  const conversation = await waitForCoreIdle(api, conversationId, { timeoutMs });
  return { turnId: sent.turn_id, acknowledged: Boolean(cancellation.runtime), conversation };
}
