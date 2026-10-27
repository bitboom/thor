import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfigProvider } from '@arco-design/web-react';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/renderer/hooks/context/ThemeContext', () => ({ useThemeContext: () => ({ theme: 'light', fontScale: 1 }) }));
import FeedbackReportModal from '@/renderer/components/settings/SettingsModal/contents/FeedbackReportModal';

afterEach(() => {
  cleanup();
  (window as unknown as { electronAPI?: unknown }).electronAPI = undefined;
});
describe('Thor public feedback', () => {
  it('shows the exact sanitized payload for review before submission', async () => {
    const submit = vi.fn().mockResolvedValue({ url: 'https://github.com/bitboom/thor/issues/1' });
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      submitThorFeedback: submit,
      getThorFeedbackPending: async () => null,
    };
    const user = userEvent.setup();
    render(
      <ConfigProvider>
        <FeedbackReportModal visible onCancel={vi.fn()} />
      </ConfigProvider>
    );
    await user.type(await screen.findByLabelText('settings.thorFeedback.titleLabel'), 'Test issue');
    await user.type(screen.getByLabelText('settings.thorFeedback.description'), 'token=supersecret');
    expect(submit).not.toHaveBeenCalled();
    await user.click(screen.getByText('settings.thorFeedback.review'));
    const preview = screen.getByTestId('thor-feedback-preview').textContent;
    expect(preview).toMatch(/^Test issue\n\ntoken=\[REDACTED\]\n\nThor report ID: [0-9a-f-]+$/);
    expect(submit).not.toHaveBeenCalled();
    await user.click(screen.getByText('settings.thorFeedback.submit'));
    await waitFor(() =>
      expect(submit).toHaveBeenCalledWith({ title: 'Test issue', body: preview?.slice('Test issue\n\n'.length) })
    );
    expect(await screen.findByText('https://github.com/bitboom/thor/issues/1')).toBeInTheDocument();
  });
  it('reports submission failure without claiming an issue was created', async () => {
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      submitThorFeedback: vi.fn().mockRejectedValue(new Error('failed')),
    };
    const user = userEvent.setup();
    render(
      <ConfigProvider>
        <FeedbackReportModal visible onCancel={vi.fn()} />
      </ConfigProvider>
    );
    await user.type(await screen.findByLabelText('settings.thorFeedback.titleLabel'), 'Issue');
    await user.type(screen.getByLabelText('settings.thorFeedback.description'), 'Description');
    await user.click(screen.getByText('settings.thorFeedback.review'));
    await user.click(screen.getByText('settings.thorFeedback.submit'));
    expect(await screen.findByText('settings.thorFeedback.failed')).toBeInTheDocument();
    expect(screen.queryByText('settings.thorFeedback.submit')).not.toBeInTheDocument();
    expect(screen.queryByText('settings.thorFeedback.created')).not.toBeInTheDocument();
  });
  it('requires GitHub CLI sign-in and provides a way to recheck', async () => {
    const submit = vi.fn();
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      submitThorFeedback: submit,
      getThorFeedbackPending: async () => null,
      getThorFeedbackAuthStatus: async () => ({ status: 'unauthenticated', executable: 'C:\\Thor\\gh.exe' }),
    };
    const user = userEvent.setup();
    render(
      <ConfigProvider>
        <FeedbackReportModal visible onCancel={vi.fn()} />
      </ConfigProvider>
    );
    await user.type(await screen.findByLabelText('settings.thorFeedback.titleLabel'), 'Issue');
    await user.type(screen.getByLabelText('settings.thorFeedback.description'), 'Description');
    await user.click(screen.getByText('settings.thorFeedback.review'));
    expect(await screen.findByText('settings.thorFeedback.authNeeded')).toBeInTheDocument();
    expect(screen.getByText('settings.thorFeedback.submit').closest('button')).toBeDisabled();
    expect(screen.getByText('settings.thorFeedback.checkAuth')).toBeInTheDocument();
    expect(submit).not.toHaveBeenCalled();
  });
  it('opens a reviewed browser draft and shows the verified issue URL', async () => {
    const open = vi.fn().mockResolvedValue(undefined);
    const verify = vi.fn().mockResolvedValue({ url: 'https://github.com/bitboom/thor/issues/42' });
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      submitThorFeedback: vi.fn(),
      getThorFeedbackPending: async () => null,
      getThorFeedbackAuthStatus: async () => ({ status: 'unauthenticated', executable: 'gh' }),
      openThorFeedbackInBrowser: open,
      verifyThorFeedback: verify,
    };
    const user = userEvent.setup();
    render(
      <ConfigProvider>
        <FeedbackReportModal visible onCancel={vi.fn()} />
      </ConfigProvider>
    );
    await user.type(await screen.findByLabelText('settings.thorFeedback.titleLabel'), 'Browser issue');
    await user.type(screen.getByLabelText('settings.thorFeedback.description'), 'Reviewed text');
    await user.click(screen.getByText('settings.thorFeedback.review'));
    await user.click(await screen.findByText('settings.thorFeedback.openBrowserDraft'));
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Browser issue',
        body: expect.stringMatching(/^Reviewed text\n\nThor report ID: /),
      })
    );
    await user.click(await screen.findByText('settings.thorFeedback.verify'));
    expect(verify).toHaveBeenCalledWith(expect.stringMatching(/^[0-9a-f-]{36}$/));
    expect(await screen.findByText('https://github.com/bitboom/thor/issues/42')).toBeInTheDocument();
  });
});
