// Deliberately invented mail. example.invalid is reserved and cannot deliver mail.
export const fixtureVersion = '1';

export const attachments = [
  { id: 'att-launch-brief', messageId: 'msg-launch-001', filename: 'launch-brief.md', mimeType: 'text/markdown', policy: 'public', text: '# Synthetic launch brief\n\nProject Lantern is an invented demonstration.\nOwner: Mina Example\nTarget: 2030-04-18\nStatus: Ready for review\n' },
  { id: 'att-launch-tasks', messageId: 'msg-launch-001', filename: 'launch-tasks.csv', mimeType: 'text/csv', policy: 'public', text: 'task,owner,status\nReview demo,Mina Example,done\nPrepare slides,Alex Sample,in progress\n' },
  { id: 'att-budget-allowed', messageId: 'msg-budget-002', filename: 'sample-budget.csv', mimeType: 'text/csv', policy: 'allow', text: 'category,amount,currency\nDemo hardware,1200,USD\nDemo materials,300,USD\nTotal,1500,USD\n' },
  { id: 'att-drm-denied', messageId: 'msg-drm-003', filename: 'restricted-simulation.txt', mimeType: 'text/plain', policy: 'deny', text: 'This synthetic body must never be returned by the denied policy.\n' },
  { id: 'att-drm-expiring', messageId: 'msg-drm-003', filename: 'temporary-simulation.txt', mimeType: 'text/plain', policy: 'expire', text: 'Temporary synthetic review note: the next review is 2030-04-19.\n' },
];

export const messages = [
  { id: 'msg-launch-001', threadId: 'thread-lantern', from: 'mina@example.invalid', to: ['demo@example.invalid'], subject: '[Synthetic] Project Lantern launch review', sentAt: '2030-04-12T09:00:00.000Z', labels: ['inbox', 'launch'], body: 'Please review the invented Project Lantern launch brief and task list. The target date is 18 April 2030. This message is a public test fixture.', attachmentIds: ['att-launch-brief', 'att-launch-tasks'] },
  { id: 'msg-budget-002', threadId: 'thread-lantern', from: 'alex@example.invalid', to: ['demo@example.invalid'], subject: '[Synthetic] Lantern sample budget', sentAt: '2030-04-11T14:30:00.000Z', labels: ['inbox', 'budget'], body: 'The sample budget totals USD 1,500. Its attachment demonstrates an allowed simulated authorization. No real financial data or enterprise DRM system is involved.', attachmentIds: ['att-budget-allowed'] },
  { id: 'msg-drm-003', threadId: 'thread-drm-demo', from: 'reviewer@example.invalid', to: ['demo@example.invalid'], subject: '[Synthetic] Protected attachment policy demo', sentAt: '2030-04-10T07:00:00.000Z', labels: ['inbox', 'policy'], body: 'This fixture exercises denied and expiring simulated authorization. The denied attachment remains unreadable; the temporary attachment requires a current process-local grant.', attachmentIds: ['att-drm-denied', 'att-drm-expiring'] },
  { id: 'msg-notes-004', threadId: 'thread-notes', from: 'sam@example.invalid', to: ['demo@example.invalid'], subject: '[Synthetic] Weekly notes', sentAt: '2030-04-09T08:00:00.000Z', labels: ['archive', 'notes'], body: 'Synthetic weekly notes: preview checks are ready. There are no attachments in this message.', attachmentIds: [] },
];
