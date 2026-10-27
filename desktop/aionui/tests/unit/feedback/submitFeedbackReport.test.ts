import { describe, expect, it } from 'vitest';
import { submitFeedbackReport } from '@/renderer/services/feedback/submitFeedbackReport';

describe('upstream feedback transport', () => {
  it('refuses to collect or send upstream diagnostics', async () => {
    await expect(
      submitFeedbackReport({ module: 'system', moduleLabel: 'System', description: 'test', collectLogs: true })
    ).rejects.toThrow('Thor does not send upstream diagnostics');
  });
});
