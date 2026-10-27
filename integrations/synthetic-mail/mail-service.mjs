import { createHash, randomUUID } from 'node:crypto';
import { attachments, fixtureVersion, messages } from './fixtures.mjs';

export class MailError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const fail = (code, message) => { throw new MailError(code, message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = value => createHash('sha256').update(value).digest('hex');

function validate(args, allowed, required = []) {
  if (!object(args)) fail('INVALID_ARGUMENT', 'Arguments must be an object.');
  for (const key of Object.keys(args)) if (!allowed.includes(key)) fail('INVALID_ARGUMENT', `Unknown argument: ${key}`);
  for (const key of required) if (!(key in args)) fail('INVALID_ARGUMENT', `Missing argument: ${key}`);
}

function string(value, name, max = 256) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) fail('INVALID_ARGUMENT', `${name} must be a nonempty string of at most ${max} characters.`);
  return value;
}

function integer(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) fail('INVALID_ARGUMENT', `${name} must be an integer from ${min} to ${max}.`);
  return value;
}

const attachmentById = id => attachments.find(item => item.id === string(id, 'attachmentId')) ?? fail('NOT_FOUND', 'Attachment not found.');
const messageById = id => messages.find(item => item.id === string(id, 'messageId')) ?? fail('NOT_FOUND', 'Message not found.');
const summary = message => ({ id: message.id, threadId: message.threadId, from: message.from, to: [...message.to], subject: message.subject, sentAt: message.sentAt, labels: [...message.labels], snippet: message.body.slice(0, 180), attachmentCount: message.attachmentIds.length });

/** Synthetic authorization is deliberately process-local and cannot unlock real files. */
export function createMailService({ now = Date.now } = {}) {
  const grants = new Map();
  const metadata = item => {
    const grant = grants.get(item.id);
    return {
      id: item.id, messageId: item.messageId, filename: item.filename, mimeType: item.mimeType,
      size: Buffer.byteLength(item.text), sha256: digest(item.text),
      protection: { simulated: true, policy: item.policy, status: item.policy === 'public' ? 'public' : item.policy === 'deny' ? 'denied' : grant ? grant.expiresAt > now() ? 'authorized' : 'expired' : 'authorization_required', ...(grant ? { expiresAt: new Date(grant.expiresAt).toISOString() } : {}) },
    };
  };

  function search(args) {
    validate(args, ['query', 'label', 'limit', 'cursor']);
    const query = args.query === undefined ? '' : string(args.query, 'query', 500).trim().toLowerCase();
    const label = args.label === undefined ? '' : string(args.label, 'label').toLowerCase();
    const limit = args.limit === undefined ? 2 : integer(args.limit, 'limit', 1, 50);
    const fingerprint = digest(JSON.stringify({ fixtureVersion, query, label }));
    const matches = messages.filter(item => (!label || item.labels.includes(label)) && (!query || `${item.subject} ${item.from} ${item.body}`.toLowerCase().includes(query)));
    let offset = 0;
    if (args.cursor !== undefined) {
      string(args.cursor, 'cursor', 1024);
      try {
        if (!/^[\w-]+$/.test(args.cursor)) throw new Error();
        const cursor = JSON.parse(Buffer.from(args.cursor, 'base64url').toString('utf8'));
        if (!object(cursor) || cursor.v !== 1 || cursor.q !== fingerprint || !Number.isInteger(cursor.o) || cursor.o <= 0 || cursor.o >= matches.length) throw new Error();
        offset = cursor.o;
      } catch { fail('INVALID_CURSOR', 'Cursor is invalid or belongs to another search.'); }
    }
    const nextOffset = offset + limit;
    return { fixtureVersion, synthetic: true, messages: matches.slice(offset, nextOffset).map(summary), total: matches.length, nextCursor: nextOffset < matches.length ? Buffer.from(JSON.stringify({ v: 1, q: fingerprint, o: nextOffset })).toString('base64url') : null };
  }

  return {
    call(name, args = {}) {
      if (name === 'mail_search') return search(args);
      if (name === 'mail_read') {
        validate(args, ['messageId'], ['messageId']);
        const item = messageById(args.messageId);
        return { synthetic: true, ...summary(item), body: item.body, attachments: item.attachmentIds.map(id => metadata(attachmentById(id))) };
      }
      if (name === 'mail_list_attachments') {
        validate(args, ['messageId'], ['messageId']);
        const item = messageById(args.messageId);
        return { synthetic: true, messageId: item.id, attachments: item.attachmentIds.map(id => metadata(attachmentById(id))) };
      }
      if (name === 'mail_authorize_attachment') {
        validate(args, ['attachmentId', 'ttlSeconds'], ['attachmentId']);
        const item = attachmentById(args.attachmentId);
        const ttl = args.ttlSeconds === undefined ? item.policy === 'expire' ? 1 : 60 : integer(args.ttlSeconds, 'ttlSeconds', 1, 300);
        if (item.policy === 'deny') fail('ACCESS_DENIED', 'Synthetic policy denies access to this attachment.');
        if (item.policy === 'public') return { synthetic: true, ...metadata(item), authorization: null };
        // The expiring fixture has a one-second policy cap even if a longer TTL is requested.
        const expiresAt = now() + Math.min(ttl, item.policy === 'expire' ? 1 : 300) * 1000;
        const grant = { token: randomUUID(), expiresAt };
        grants.set(item.id, grant);
        return { synthetic: true, ...metadata(item), authorization: grant.token };
      }
      if (name === 'mail_read_attachment') {
        validate(args, ['attachmentId', 'authorization', 'encoding'], ['attachmentId']);
        const item = attachmentById(args.attachmentId);
        const encoding = args.encoding ?? 'text';
        if (!['text', 'base64'].includes(encoding)) fail('INVALID_ARGUMENT', 'encoding must be text or base64.');
        if (args.authorization !== undefined) string(args.authorization, 'authorization');
        if (item.policy === 'deny') fail('ACCESS_DENIED', 'Synthetic policy denies access to this attachment.');
        if (item.policy !== 'public') {
          const grant = grants.get(item.id);
          if (!grant || args.authorization !== grant.token) fail('AUTHORIZATION_REQUIRED', 'Authorize this synthetic attachment and provide its process-local authorization value.');
          if (grant.expiresAt <= now()) fail('AUTHORIZATION_EXPIRED', 'Synthetic authorization expired. Authorize the attachment again.');
        }
        return { synthetic: true, ...metadata(item), encoding, content: encoding === 'base64' ? Buffer.from(item.text).toString('base64') : item.text };
      }
      if (name === 'mail_reset_session') {
        validate(args, []);
        grants.clear();
        return { synthetic: true, revoked: true };
      }
      fail('UNKNOWN_TOOL', 'Unknown tool.');
    },
  };
}
