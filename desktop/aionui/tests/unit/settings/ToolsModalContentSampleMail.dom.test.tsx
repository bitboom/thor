/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const hooks = vi.hoisted(() => ({
  modelListWithImage: [] as unknown[],
  mcpServers: [] as unknown[],
  getClientBusinessSetting: vi.fn(() => Promise.resolve(undefined)),
  getConfig: vi.fn(),
  testConnection: vi.fn(),
  batchImport: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key }),
}));

vi.mock('@/renderer/components/base/AionScrollArea', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/renderer/components/base/AionSelect', () => {
  const Select = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return { default: Object.assign(Select, { OptGroup: Select, Option: Select }) };
});

vi.mock('@/renderer/components/base/TalkToButlerButton', () => ({
  default: () => <div>TalkToButlerButton</div>,
}));

vi.mock('@/renderer/pages/settings/components/AddMcpServerModal', () => ({
  default: () => null,
}));

vi.mock('@/renderer/pages/settings/ToolsSettings/McpServerItem', () => ({
  default: () => null,
}));

vi.mock('@/renderer/hooks/agent/useConfigModelListWithImage', () => ({
  default: () => ({ modelListWithImage: hooks.modelListWithImage }),
}));

vi.mock('@/renderer/hooks/mcp', () => ({
  useMcpServers: () => ({
    mcpServers: hooks.mcpServers,
    extensionMcpServers: [],
    saveMcpServers: vi.fn(() => Promise.resolve()),
    setMcpServers: vi.fn(),
    isMcpServersLoading: false,
  }),
  useMcpConnection: () => ({ testingServers: {}, handleTestMcpConnection: vi.fn(), handleTestMcpConnections: vi.fn() }),
  useMcpModal: () => ({
    showMcpModal: false,
    editingMcpServer: undefined,
    deleteConfirmVisible: false,
    serverToDelete: undefined,
    mcpCollapseKey: [],
    showAddMcpModal: vi.fn(),
    showEditMcpModal: vi.fn(),
    hideMcpModal: vi.fn(),
    showDeleteConfirm: vi.fn(),
    hideDeleteConfirm: vi.fn(),
    toggleServerCollapse: vi.fn(),
  }),
  useMcpServerCRUD: () => ({
    handleAddMcpServer: vi.fn(),
    handleBatchImportMcpServers: hooks.batchImport,
    handleEditMcpServer: vi.fn(),
    handleDeleteMcpServer: vi.fn(),
  }),
  useMcpOAuth: () => ({
    oauthStatus: {},
    loggingIn: {},
    checkOAuthStatus: vi.fn(),
    markLoginRequired: vi.fn(),
    clearLoginRequired: vi.fn(),
    login: vi.fn(),
  }),
  useMountedMessage: () => ({ success: hooks.success, error: hooks.error }),
}));

vi.mock('@/renderer/services/clientBusinessSettings', () => ({
  getClientBusinessSetting: hooks.getClientBusinessSetting,
  setClientBusinessSetting: vi.fn(() => Promise.resolve()),
  removeClientBusinessSetting: vi.fn(() => Promise.resolve()),
}));

vi.mock('@/common/adapter/ipcBridge', () => ({
  mcpService: { testMcpConnection: { invoke: hooks.testConnection } },
}));

import ToolsModalContent from '@/renderer/components/settings/SettingsModal/contents/ToolsModalContent';

describe('Tools settings sample mail registration', () => {
  const toolNames = [
    'mail_search',
    'mail_read',
    'mail_list_attachments',
    'mail_authorize_attachment',
    'mail_read_attachment',
    'mail_reset_session',
  ];
  beforeEach(() => {
    vi.clearAllMocks();
    hooks.mcpServers = [];
    hooks.modelListWithImage = [];
    hooks.getConfig.mockResolvedValue({ command: 'electron', script: 'synthetic.mjs' });
    hooks.testConnection.mockResolvedValue({ success: true, tools: toolNames.map((name) => ({ name })) });
    hooks.batchImport.mockResolvedValue([{ id: 'sample' }]);
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { getThorSyntheticMailConfig: hooks.getConfig },
    });
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  });
  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(window, 'electronAPI');
  });

  it('registers the verified sample from the rendered Tools settings', async () => {
    render(<ToolsModalContent />);
    fireEvent.click(screen.getByRole('button', { name: 'settings.thorSample.add' }));
    await waitFor(() => expect(hooks.batchImport).toHaveBeenCalledOnce());
    expect(hooks.testConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'thor_synthetic_mail',
        transport: {
          type: 'stdio',
          command: 'electron',
          args: ['synthetic.mjs'],
          env: { ELECTRON_RUN_AS_NODE: '1' },
        },
      })
    );
    expect(hooks.success).toHaveBeenCalledWith('settings.thorSample.success');
  });

  it('does not import when the protocol lacks a required tool', async () => {
    hooks.testConnection.mockResolvedValue({ success: true, tools: [] });
    render(<ToolsModalContent />);
    fireEvent.click(screen.getByRole('button', { name: 'settings.thorSample.add' }));
    await waitFor(() => expect(hooks.error).toHaveBeenCalledWith('settings.thorSample.failed'));
    expect(hooks.batchImport).not.toHaveBeenCalled();
  });

  it('disables the control for an existing sample', () => {
    hooks.mcpServers = [{ name: 'thor_synthetic_mail', transport: { type: 'stdio' } }];
    render(<ToolsModalContent />);
    expect(screen.getByRole('button', { name: 'settings.thorSample.added' })).toBeDisabled();
  });

  it('hides the control when the desktop bridge is unavailable', () => {
    Reflect.deleteProperty(window, 'electronAPI');
    render(<ToolsModalContent />);
    expect(screen.queryByRole('button', { name: 'settings.thorSample.add' })).toBeNull();
  });
});
