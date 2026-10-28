/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */
import AionModal from '@renderer/components/base/AionModal';
import { prepareThorFeedback } from '@/common/types/feedbackDiagnostics';
import { openExternalUrl } from '@/renderer/utils/platform';
import { Button, Input } from '@arco-design/web-react';
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { FeedbackEventExtra, FeedbackEventTags } from '@/renderer/services/feedback/submitFeedbackReport';
import type {
  FeedbackDiagnosticsExplicitContext,
  FeedbackDiagnosticsProfile,
} from '@/common/types/feedbackDiagnostics';
export type { FeedbackEventExtra, FeedbackEventTags } from '@/renderer/services/feedback/submitFeedbackReport';
export type PrefilledScreenshot = { filename: string; data: Uint8Array; type: string };

type FeedbackReportModalProps = {
  visible: boolean;
  onCancel: () => void;
  initialTitle?: string;
  initialBody?: string;
  defaultModule?: string;
  prefilledScreenshots?: PrefilledScreenshot[];
  feedbackTags?: FeedbackEventTags;
  feedbackExtra?: FeedbackEventExtra;
  feedbackDiagnosticsContext?: {
    explicitContext?: FeedbackDiagnosticsExplicitContext;
    explicitProfiles?: FeedbackDiagnosticsProfile[];
    routeAtOpen?: string;
  };
};

const FeedbackReportModal: React.FC<FeedbackReportModalProps> = ({
  visible,
  onCancel,
  initialTitle = '',
  initialBody = '',
}) => {
  const { t } = useTranslation();
  const [title, setTitle] = useState(initialTitle);
  const [body, setBody] = useState(initialBody);
  const [review, setReview] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [issueUrl, setIssueUrl] = useState('');
  const [auth, setAuth] = useState<{
    status: 'authenticated' | 'unauthenticated' | 'missing';
    executable: string;
  } | null>(null);
  const refreshAuth = async () => {
    const getStatus = window.electronAPI?.getThorFeedbackAuthStatus;
    if (getStatus) setAuth(await getStatus().catch(() => ({ status: 'missing' as const, executable: 'gh' })));
  };
  const [pending, setPending] = useState<string | null | undefined>(undefined);
  const [reportId, setReportId] = useState<string>(() => crypto.randomUUID());
  const restoreRecord = (
    record: {
      reportId: string;
      draft: { title: string; body: string } | null;
      state: 'pending' | 'submitted';
      url?: string;
    } | null
  ) => {
    if (!record) {
      setPending(null);
      return;
    }
    setReportId(record.reportId);
    if (record.draft) {
      setTitle(record.draft.title);
      setBody(record.draft.body.replace(/\n\nThor report ID: [0-9a-f-]+$/i, ''));
    } else {
      setTitle('');
      setBody('');
    }
    if (record.state === 'submitted' && record.url) {
      setPending(null);
      setIssueUrl(record.url);
    } else setPending(record.reportId);
  };
  useEffect(() => {
    if (!visible) return;
    setAuth(null);
    void refreshAuth();
    let active = true;
    setPending(undefined);
    const getPending = window.electronAPI?.getThorFeedbackPending;
    if (!getPending) {
      setPending(null);
      return;
    }
    void getPending()
      .then((record) => {
        if (active) restoreRecord(record);
      })
      .catch(() => {
        if (active) {
          setTitle('');
          setBody('');
          setPending('unknown');
        }
      });
    return () => {
      active = false;
    };
  }, [visible]);
  const draft = useMemo(() => {
    const sanitized = prepareThorFeedback(title, body);
    if (!sanitized.body) return sanitized;
    return prepareThorFeedback(sanitized.title, sanitized.body.slice(0, 9900) + '\n\nThor report ID: ' + reportId);
  }, [title, body, reportId]);
  const resolvePending = async () => {
    if ((!pending && !issueUrl) || !window.electronAPI?.resolveThorFeedbackPending) return;
    try {
      await window.electronAPI.resolveThorFeedbackPending(pending || reportId);
      setPending(null);
      setIssueUrl('');
      setTitle('');
      setBody('');
      setError('');
      setReview(false);
      setReportId(crypto.randomUUID());
    } catch {
      setError(t('settings.thorFeedback.failed'));
    }
  };
  const openBrowserDraft = async () => {
    const open = window.electronAPI?.openThorFeedbackInBrowser;
    if (!open) return;
    setSubmitting(true);
    try {
      await open(draft);
      setPending(reportId);
    } catch {
      const getPending = window.electronAPI?.getThorFeedbackPending;
      if (getPending)
        restoreRecord(
          await getPending().catch(() => ({ reportId: 'unknown', draft: null as null, state: 'pending' as const }))
        );
      else setPending('unknown');
      setError(t('settings.thorFeedback.browserFailed'));
    } finally {
      setSubmitting(false);
    }
  };
  const verifyPending = async () => {
    if (!pending || !window.electronAPI?.verifyThorFeedback) return;
    setSubmitting(true);
    try {
      const result = await window.electronAPI.verifyThorFeedback(pending);
      if (result) {
        setPending(null);
        setIssueUrl(result.url);
        setError('');
      } else setError(t('settings.thorFeedback.notFound'));
    } catch {
      setError(t('settings.thorFeedback.notFound'));
    } finally {
      setSubmitting(false);
    }
  };
  const close = () => {
    setTitle('');
    setBody('');
    setReview(false);
    setError('');
    setIssueUrl('');
    setReportId(crypto.randomUUID());
    onCancel();
  };
  const submit = async () => {
    const submitFeedback = window.electronAPI?.submitThorFeedback;
    if (!submitFeedback) {
      setError(t('settings.thorFeedback.desktopOnly'));
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const result = await submitFeedback(draft);
      setIssueUrl(result.url);
    } catch {
      const getPending = window.electronAPI?.getThorFeedbackPending;
      if (getPending)
        restoreRecord(
          await getPending().catch(() => ({ reportId: 'unknown', draft: null as null, state: 'pending' as const }))
        );
      else setPending('unknown');
      setError(t('settings.thorFeedback.failed'));
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <AionModal
      variant='standard'
      header={{ title: t('settings.thorFeedback.title'), showClose: true }}
      visible={visible}
      onCancel={close}
      alignCenter
      className='w-[min(600px,calc(100vw-32px))] max-w-600px'
      footer={{
        render: () => (
          <div className='flex justify-end gap-8px'>
            <Button onClick={close} disabled={submitting}>
              {t('settings.thorFeedback.close')}
            </Button>
            {!issueUrl && pending === null && review && (
              <Button
                disabled={submitting}
                onClick={() => {
                  setError('');
                  setReview(false);
                }}
              >
                {t('settings.thorFeedback.edit')}
              </Button>
            )}
            {!issueUrl && !error && pending === null && !review && (
              <Button type='primary' disabled={!draft.title || !draft.body} onClick={() => setReview(true)}>
                {t('settings.thorFeedback.review')}
              </Button>
            )}
            {!issueUrl &&
              !error &&
              pending === null &&
              review &&
              auth &&
              auth.status !== 'authenticated' &&
              window.electronAPI?.openThorFeedbackInBrowser && (
                <Button disabled={submitting} onClick={() => void openBrowserDraft()}>
                  {t('settings.thorFeedback.openBrowserDraft')}
                </Button>
              )}
            {!issueUrl && !error && pending === null && review && (
              <Button
                type='primary'
                loading={submitting}
                disabled={Boolean(window.electronAPI?.getThorFeedbackAuthStatus) && auth?.status !== 'authenticated'}
                onClick={() => void submit()}
              >
                {t('settings.thorFeedback.submit')}
              </Button>
            )}
          </div>
        ),
      }}
    >
      <div className='flex flex-col gap-12px'>
        <p>{t('settings.thorFeedback.intro')}</p>
        <p>{t('settings.thorFeedback.warning')}</p>
        {pending ? (
          <>
            <div role='alert'>
              {t('settings.thorFeedback.pending')} {pending}
            </div>
            {body && (
              <pre className='whitespace-pre-wrap break-all bg-fill-1 p-12px'>
                {draft.title}
                {'\n\n'}
                {draft.body}
              </pre>
            )}
            <Button
              type='text'
              onClick={() =>
                void openExternalUrl('https://github.com/bitboom/thor/issues?q=' + encodeURIComponent(pending))
              }
            >
              {t('settings.thorFeedback.searchReport')}
            </Button>
            {window.electronAPI?.verifyThorFeedback && (
              <Button loading={submitting} onClick={() => void verifyPending()}>
                {t('settings.thorFeedback.verify')}
              </Button>
            )}
            <Button disabled={submitting} onClick={() => void resolvePending()}>
              {t('settings.thorFeedback.checked')}
            </Button>
          </>
        ) : pending === undefined ? null : issueUrl ? (
          <div>
            <p>{t('settings.thorFeedback.created')}</p>
            <Button onClick={() => void resolvePending()}>
              {t('settings.thorFeedback.archive', { defaultValue: 'Archive this report' })}
            </Button>
            <Button type='text' onClick={() => void openExternalUrl(issueUrl)}>
              {issueUrl}
            </Button>
          </div>
        ) : review ? (
          <>
            <strong>{t('settings.thorFeedback.preview')}</strong>
            <pre className='whitespace-pre-wrap break-all bg-fill-1 p-12px' data-testid='thor-feedback-preview'>
              {draft.title}
              {'\n\n'}
              {draft.body}
            </pre>
            <p>{t('settings.thorFeedback.auth')}</p>
            {auth && (
              <div>
                <p>
                  {t(
                    auth.status === 'authenticated'
                      ? 'settings.thorFeedback.authReady'
                      : auth.status === 'missing'
                        ? 'settings.thorFeedback.authMissing'
                        : 'settings.thorFeedback.authNeeded'
                  )}
                </p>
                {auth.status !== 'authenticated' && (
                  <>
                    <p>{t('settings.thorFeedback.loginGuide')}</p>
                    <code className='break-all'>
                      {' '}
                      &amp; &quot;{auth.executable}&quot; auth login --hostname github.com --web
                    </code>
                    <div>
                      <Button onClick={() => void refreshAuth()}>{t('settings.thorFeedback.checkAuth')}</Button>
                    </div>
                  </>
                )}
              </div>
            )}
          </>
        ) : (
          <>
            <label>
              {t('settings.thorFeedback.titleLabel')}
              <Input value={title} onChange={setTitle} maxLength={500} />
            </label>
            <label>
              {t('settings.thorFeedback.description')}
              <Input.TextArea
                value={body}
                onChange={setBody}
                maxLength={12000}
                autoSize={{ minRows: 5, maxRows: 10 }}
              />
            </label>
          </>
        )}
        {error && (
          <>
            <div className='text-danger' role='alert'>
              {error}
            </div>
            <Button type='text' onClick={() => void openExternalUrl('https://github.com/bitboom/thor/issues')}>
              {t('settings.thorFeedback.openIssues')}
            </Button>
          </>
        )}
      </div>
    </AionModal>
  );
};
export default FeedbackReportModal;
