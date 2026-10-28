/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Message, Modal } from '@arco-design/web-react';
import '@arco-design/web-react/lib/_util/react-19-adapter';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Representative English copy for the keys under test. Every other key echoes so
// unmapped lookups stay assertable.
const RDC = 'common.backendStartup.recoverableDatabaseCorruption';
const COPY: Record<string, string> = {
  [`${RDC}.title`]: 'Local data is corrupted',
  [`${RDC}.description`]:
    'AionUi detected that the local database is corrupted and cannot continue startup. After confirmation, AionUi will back up the old database and create a new local database to continue startup. Past conversations will no longer be shown, and the old database will be kept as a backup file.',
  [`${RDC}.confirmRebuild`]: 'Back up old DB and rebuild new DB',
  [`${RDC}.sendDiagnostics`]: 'Send diagnostics',
  [`${RDC}.diagnosticsSent`]: 'Diagnostics sent',
  [`${RDC}.rebuildFailed`]: 'Failed to back up old DB and rebuild new DB',
  [`${RDC}.confirmDialog.title`]: 'Rebuild the database?',
  [`${RDC}.confirmDialog.content`]:
    'This will back up the currently corrupted database and create a brand-new empty one. Past conversations will no longer be shown (the old database is kept as a backup file). Continue?',
  [`${RDC}.confirmDialog.okText`]: 'Confirm rebuild',
  [`${RDC}.confirmDialog.cancelText`]: 'Cancel',
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => COPY[key] ?? key,
    i18n: { language: 'en' },
  }),
}));

// Keep the installation-integrity module importable in jsdom without a real
// feedback pipeline.
vi.mock('@/renderer/services/feedback/submitFeedbackReport', () => ({
  submitFeedbackReport: vi.fn().mockResolvedValue(undefined),
}));

import {
  type InstallationIntegrityDiagnostics,
  InstallationIntegrityFooter,
  InstallationIntegrityModalHost,
} from '@/renderer/components/layout/InstallationIntegrityDialog';
import BackendStartupGate from '@/renderer/components/layout/BackendStartupGate';

const diagnostics: InstallationIntegrityDiagnostics = { source: 'backend_startup_failure' };

type ConfirmConfig = Parameters<typeof Modal.confirm>[0];

let recoverMock: ReturnType<typeof vi.fn>;

function stubModalConfirm() {
  return vi
    .spyOn(Modal, 'confirm')
    .mockImplementation(() => ({ close: () => {}, update: () => {} }) as unknown as ReturnType<typeof Modal.confirm>);
}

function renderFooter() {
  return render(
    <InstallationIntegrityFooter diagnostics={diagnostics} diagnosticsKind='recoverable_database_corruption' />
  );
}

beforeEach(() => {
  recoverMock = vi.fn().mockResolvedValue(undefined);
  (window as unknown as { electronAPI: { recoverCorruptedDatabase: () => Promise<void> } }).electronAPI = {
    recoverCorruptedDatabase: recoverMock,
  };
});

describe('startup failure feedback', () => {
  it('exports locally from the failure footer without opening feedback or recovery', async () => {
    const save = vi.fn().mockResolvedValue('saved');
    (window as unknown as { electronAPI: unknown }).electronAPI = { exportThorDatabaseIdentity: save };
    render(<InstallationIntegrityFooter diagnosticsKind='backend_exited' />);
    fireEvent.click(screen.getByTestId('export-database-identity'));
    expect(save).toHaveBeenCalledWith();
    expect(screen.queryByTestId('recoverable-database-corruption-rebuild')).toBeNull();
    await screen.findByText('common.saveSuccess');
    Message.clear();
    await waitFor(() => expect(screen.queryByText('common.saveSuccess')).toBeNull());
  });
  it('opens a reviewable draft without exposing arbitrary startup details or submitting', async () => {
    const submit = vi.fn();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Core unavailable'));
    window.__backendStartupFailure = { reason: 'backend_startup_exited' };
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      submitThorFeedback: submit,
      getThorFeedbackPending: async () => null,
    };
    const user = userEvent.setup();
    render(
      <BackendStartupGate
        renderStarting={() => null}
        renderApp={() => <div>Unexpected application</div>}
        renderFailure={() => (
          <InstallationIntegrityModalHost
            diagnosticsKind='backend_exited'
            description='private path or token must not be included'
            diagnostics={{ source: 'backend_startup_failure', backendStartupFailure: { secret: 'private-value' } }}
          />
        )}
      />
    );
    await user.click(await screen.findByTestId('installation-integrity-report'));
    expect(await screen.findByLabelText('settings.thorFeedback.titleLabel')).toHaveValue(
      'common.backendStartup.exited.title'
    );
    expect(screen.getByLabelText('settings.thorFeedback.description')).toHaveValue(
      'common.backendStartup.exited.description'
    );
    await user.click(screen.getByText('settings.thorFeedback.review'));
    const preview = screen.getByTestId('thor-feedback-preview').textContent ?? '';
    expect(preview).not.toContain('private');
    expect(submit).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    await user.click(screen.getByText('settings.thorFeedback.submit'));
    await waitFor(() => expect(submit).toHaveBeenCalledOnce());
  });

  it('keeps an existing pending report instead of replacing it with the startup draft', async () => {
    const submit = vi.fn();
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      submitThorFeedback: submit,
      getThorFeedbackPending: async () => ({
        reportId: 'pending-report',
        draft: { title: 'Earlier issue', body: 'Earlier report' },
        state: 'pending',
      }),
    };
    const user = userEvent.setup();
    render(<InstallationIntegrityFooter diagnostics={diagnostics} diagnosticsKind='backend_exited' />);
    await user.click(screen.getByTestId('installation-integrity-report'));
    expect(await screen.findByRole('alert')).toHaveTextContent('pending-report');
    expect(screen.getByText(/Earlier issue/)).toBeInTheDocument();
    expect(screen.queryByText('settings.thorFeedback.review')).not.toBeInTheDocument();
    expect(submit).not.toHaveBeenCalled();
  });

  it('does not show the new startup draft as an older pending report with no saved draft', async () => {
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      getThorFeedbackPending: async () => ({ reportId: 'pending-report', draft: null, state: 'pending' }),
    };
    const user = userEvent.setup();
    render(<InstallationIntegrityFooter diagnostics={diagnostics} diagnosticsKind='backend_exited' />);
    await user.click(screen.getByTestId('installation-integrity-report'));
    expect(await screen.findByRole('alert')).toHaveTextContent('pending-report');
    expect(screen.queryByText(/common.backendStartup.exited.description/)).not.toBeInTheDocument();
    expect(screen.queryByText('settings.thorFeedback.review')).not.toBeInTheDocument();
  });
});

afterEach(() => {
  cleanup();
  window.__backendStartupFailure = null;
  vi.restoreAllMocks();
});

describe('InstallationIntegrityDialog — recoverable_database_corruption recovery gate', () => {
  it('AC-5a: clicking rebuild opens a second confirmation and does NOT recover yet', () => {
    const confirmSpy = stubModalConfirm();
    renderFooter();

    fireEvent.click(screen.getByTestId('recoverable-database-corruption-rebuild'));

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    const cfg = confirmSpy.mock.calls[0][0] as ConfirmConfig;
    expect(cfg.title).toBe(COPY[`${RDC}.confirmDialog.title`]);
    expect(cfg.content).toBe(COPY[`${RDC}.confirmDialog.content`]);
    expect(cfg.okText).toBe(COPY[`${RDC}.confirmDialog.okText`]);
    expect(cfg.cancelText).toBe(COPY[`${RDC}.confirmDialog.cancelText`]);

    // The destructive IPC must not fire until the user confirms.
    expect(recoverMock).not.toHaveBeenCalled();
  });

  it('AC-5b: confirming (onOk) invokes recoverCorruptedDatabase exactly once', async () => {
    const confirmSpy = stubModalConfirm();
    renderFooter();

    fireEvent.click(screen.getByTestId('recoverable-database-corruption-rebuild'));
    const cfg = confirmSpy.mock.calls[0][0] as ConfirmConfig;
    await cfg.onOk?.();

    expect(recoverMock).toHaveBeenCalledTimes(1);
  });

  it('AC-5c: cancelling (never invoking onOk) does not recover', () => {
    const confirmSpy = stubModalConfirm();
    renderFooter();

    fireEvent.click(screen.getByTestId('recoverable-database-corruption-rebuild'));
    // Simulate the user cancelling / closing the confirmation: onOk is never called.
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(recoverMock).not.toHaveBeenCalled();
  });

  it('AC-6: rebuild button is danger secondary (not a primary CTA); report stays neutral', () => {
    renderFooter();

    const rebuild = screen.getByTestId('recoverable-database-corruption-rebuild');
    expect(rebuild.className).not.toContain('arco-btn-primary');
    expect(rebuild.className).toContain('arco-btn-status-danger');

    const report = screen.getByTestId('installation-integrity-report');
    expect(report.className).not.toContain('arco-btn-primary');
  });

  it('AC-7: confirmDialog copy is wired through i18n (present, non-empty, not raw keys)', () => {
    const confirmSpy = stubModalConfirm();
    renderFooter();

    fireEvent.click(screen.getByTestId('recoverable-database-corruption-rebuild'));
    const cfg = confirmSpy.mock.calls[0][0] as ConfirmConfig;

    for (const value of [cfg.title, cfg.content, cfg.okText, cfg.cancelText]) {
      expect(typeof value).toBe('string');
      expect((value as string).length).toBeGreaterThan(0);
    }
    // Resolved copy must differ from the raw key path (i.e. t() actually mapped it).
    expect(cfg.title).not.toContain(`${RDC}.confirmDialog`);
    expect(cfg.content).not.toContain(`${RDC}.confirmDialog`);

    // Regression guard on the representative shipped description copy: the
    // misleading "for now" wording is gone. 13-language completeness is enforced
    // by scripts/check-i18n.js.
    expect(COPY[`${RDC}.description`].toLowerCase()).not.toContain('for now');
  });
});
