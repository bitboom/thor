/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

export type FeedbackModule = {
  readonly i18nKey: string;
  readonly descriptionI18nKey: string;
  readonly tag: string;
};

export const FEEDBACK_MODULES = [
  {
    i18nKey: 'settings.bugReportModulePermission',
    descriptionI18nKey: 'settings.bugReportModulePermissionDescription',
    tag: 'agent-detection',
  },
  {
    i18nKey: 'settings.bugReportModuleAssistant',
    descriptionI18nKey: 'settings.bugReportModuleAssistantDescription',
    tag: 'assistant-preset',
  },
  {
    i18nKey: 'settings.bugReportModuleLlmConfig',
    descriptionI18nKey: 'settings.bugReportModuleLlmConfigDescription',
    tag: 'model-auth',
  },
  {
    i18nKey: 'settings.bugReportModuleMcp',
    descriptionI18nKey: 'settings.bugReportModuleMcpDescription',
    tag: 'mcp-tools',
  },
  {
    i18nKey: 'settings.bugReportModuleSkills',
    descriptionI18nKey: 'settings.bugReportModuleSkillsDescription',
    tag: 'skills-plugin',
  },
  {
    i18nKey: 'settings.bugReportModuleChannel',
    descriptionI18nKey: 'settings.bugReportModuleChannelDescription',
    tag: 'channel',
  },
  {
    i18nKey: 'settings.bugReportModuleChat',
    descriptionI18nKey: 'settings.bugReportModuleChatDescription',
    tag: 'conversation-session',
  },
  {
    i18nKey: 'settings.bugReportModuleSession',
    descriptionI18nKey: 'settings.bugReportModuleSessionDescription',
    tag: 'search-history',
  },
  {
    i18nKey: 'settings.bugReportModuleWorkspace',
    descriptionI18nKey: 'settings.bugReportModuleWorkspaceDescription',
    tag: 'workspace-preview',
  },
  {
    i18nKey: 'settings.bugReportModuleWebui',
    descriptionI18nKey: 'settings.bugReportModuleWebuiDescription',
    tag: 'webui-remote',
  },
  {
    i18nKey: 'settings.bugReportModuleScheduledTask',
    descriptionI18nKey: 'settings.bugReportModuleScheduledTaskDescription',
    tag: 'scheduled-task',
  },
  {
    i18nKey: 'settings.bugReportModuleAgentTeam',
    descriptionI18nKey: 'settings.bugReportModuleAgentTeamDescription',
    tag: 'agent-team',
  },
  {
    i18nKey: 'settings.bugReportModuleDisplaySettings',
    descriptionI18nKey: 'settings.bugReportModuleDisplaySettingsDescription',
    tag: 'display-desktop',
  },
  {
    i18nKey: 'settings.bugReportModuleSystemSettings',
    descriptionI18nKey: 'settings.bugReportModuleSystemSettingsDescription',
    tag: 'system-settings',
  },
  {
    i18nKey: 'settings.bugReportModuleOther',
    descriptionI18nKey: 'settings.bugReportModuleOtherDescription',
    tag: 'other',
  },
] as const satisfies readonly FeedbackModule[];

export type FeedbackModuleTag = (typeof FEEDBACK_MODULES)[number]['tag'];

export type FeedbackDiagnosticsProfile = FeedbackModuleTag | 'global-summary';

export type FeedbackDiagnosticsExplicitContext = {
  agentId?: string;
  assistantDefinitionId?: string;
  assistantId?: string;
  conversationId?: string;
  mcpServerId?: string;
  mcpServerName?: string;
  messageId?: string;
  modelId?: string;
  msgId?: string;
  providerId?: string;
  routePath?: string;
  slotId?: string;
  teamId?: string;
};

export type FeedbackDiagnosticsContextInput = {
  explicitContext?: FeedbackDiagnosticsExplicitContext;
  explicitProfiles?: FeedbackDiagnosticsProfile[];
  routeAtOpen?: string;
  routeAtSubmit?: string;
  selectedModule?: string;
};

// Recognize common provider-prefixed credentials as well as OAuth JSON keys.
const feedbackCredentialKey = String.raw`(?:[a-z0-9]+[_-])*(?:password|passwd|secret|token|api[_-]?key|authorization|cookie|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret)`;
// An unclosed quote consumes the rest of its line, including escaped quotes.
const feedbackQuotedValue = String.raw`(?:"(?:\\[^\r\n]|[^"\\\r\n])*(?:"|$)|'(?:\\[^\r\n]|[^'\\\r\n])*(?:'|$))`;
// Escaped log/JSON wrappers can obscure both key and value boundaries. Redact
// the whole affected line so escaped delimiters cannot leave a secret tail.
const feedbackEscapedCredentialLine = new RegExp(
  String.raw`^[^\r\n]*(?:\\+["']${feedbackCredentialKey}\\+["'][ \t]*[:=]|\b${feedbackCredentialKey}[ \t]*[:=][ \t]*\\+["'])[^\r\n]*`,
  'gim'
);
const feedbackJsonCredential = new RegExp(
  String.raw`((["'])${feedbackCredentialKey}\2[ \t]*[:=][ \t]*)${feedbackQuotedValue}`,
  'gim'
);
const feedbackQuotedAssignment = new RegExp(
  String.raw`(\b${feedbackCredentialKey}[ \t]*[:=][ \t]*)${feedbackQuotedValue}`,
  'gim'
);
const feedbackAssignment = new RegExp(String.raw`(\b${feedbackCredentialKey}[ \t]*[:=][ \t]*)[^\s,;]+`, 'gi');

/** Thor public-feedback text preparation. No diagnostics are collected here. */
export function sanitizeFeedbackText(value: string): string {
  return value
    .replace(
      /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/gi,
      '[REDACTED PRIVATE KEY]'
    )
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9_]{10,}|github_pat_[A-Za-z0-9_]{10,}|sk-[A-Za-z0-9_-]{10,})\b/g,
      '[REDACTED TOKEN]'
    )
    .replace(/^(\s*(?:cookie|set-cookie|authorization)\s*:)\s*[^\r\n]*/gim, '$1 [REDACTED]')
    .replace(feedbackEscapedCredentialLine, '[REDACTED CREDENTIAL LINE]')
    .replace(feedbackJsonCredential, '$1"[REDACTED]"')
    .replace(feedbackQuotedAssignment, '$1"[REDACTED]"')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(feedbackAssignment, '$1[REDACTED]')
    .replace(/\bfile:(?:\\?\/){2}[^\r\n\t"<>|]*/gi, '[REDACTED PATH]')
    .replace(/https?:\/\/[^\s<>]+/gi, '[REDACTED URL]')
    .replace(/\\{2,4}[^\\/\s"<>|]+[^\r\n\t"<>|]*/g, '[REDACTED PATH]')
    .replace(/(?<![:/])\/\/[^/\s"<>|]+\/[^\r\n\t"<>|]*/g, '[REDACTED PATH]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED EMAIL]')
    .replace(/\b[A-Za-z]:[\\/][^\r\n\t"<>|]*/g, '[REDACTED PATH]')
    .replace(/(?:^|\s)(?:\/(?:Users|home|tmp|var|mnt|opt)\/[^\s]+)/g, ' [REDACTED PATH]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[REDACTED IP]')
    .trim();
}

export type ThorFeedbackPayload = { title: string; body: string };
export function prepareThorFeedback(title: string, body: string): ThorFeedbackPayload {
  return { title: sanitizeFeedbackText(title).slice(0, 200), body: sanitizeFeedbackText(body).slice(0, 10000) };
}
