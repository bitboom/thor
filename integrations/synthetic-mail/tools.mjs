const id = name => ({ type: 'string', minLength: 1, maxLength: 256, description: `${name} returned by another mail tool.` });
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const annotations = (readOnlyHint = true) => ({ readOnlyHint, destructiveHint: false, idempotentHint: readOnlyHint, openWorldHint: false });
const tool = (name, description, inputSchema, readOnlyHint = true) => ({ name, description, inputSchema, annotations: annotations(readOnlyHint) });

export const tools = [
  tool('mail_search', 'Search invented fixture mail only. Results use stable IDs and opaque pagination cursors; omit query to list all mail.', schema({ query: { type: 'string', minLength: 1, maxLength: 500 }, label: { type: 'string', minLength: 1, maxLength: 256 }, limit: { type: 'integer', minimum: 1, maximum: 50, default: 2 }, cursor: { type: 'string', minLength: 1, maxLength: 1024 } })),
  tool('mail_read', 'Read one invented message and attachment metadata. Attachment body access is a separate tool.', schema({ messageId: id('Message ID') }, ['messageId'])),
  tool('mail_list_attachments', 'List attachment metadata, checksums, and simulated policy state for one invented message.', schema({ messageId: id('Message ID') }, ['messageId'])),
  tool('mail_authorize_attachment', 'Simulate authorization for an invented attachment. Policy determines allow, deny, or one-second expiration. This does not authenticate to or decrypt any real enterprise system.', schema({ attachmentId: id('Attachment ID'), ttlSeconds: { type: 'integer', minimum: 1, maximum: 300, default: 60 } }, ['attachmentId']), false),
  tool('mail_read_attachment', 'Read an invented attachment as text or base64. Protected samples require the current authorization value from mail_authorize_attachment. Denied samples never disclose a body.', schema({ attachmentId: id('Attachment ID'), authorization: { type: 'string', minLength: 1, maxLength: 256 }, encoding: { type: 'string', enum: ['text', 'base64'], default: 'text' } }, ['attachmentId'])),
  tool('mail_reset_session', 'Revoke all simulated attachment grants in this MCP process. Fixtures remain unchanged.', schema({}), false),
];
