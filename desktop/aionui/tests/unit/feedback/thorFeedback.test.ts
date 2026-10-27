import { describe, expect, it } from 'vitest';
import { prepareThorFeedback } from '../../../packages/desktop/src/common/types/feedbackDiagnostics';

describe('public Thor feedback preparation', () => {
  it('redacts common credentials, paths, addresses and URLs before review', () => {
    const original =
      'token=topsecret\nC:\\Users\\person\\report.docx\nperson@example.com\nhttps://private.example/path';
    const draft = prepareThorFeedback('Problem', original);
    expect(draft.body).not.toContain('topsecret');
    expect(draft.body).not.toContain('person');
    expect(draft.body).not.toContain('private.example');
  });
  it('removes cookie and Basic authorization headers, JSON secrets and slash paths', () => {
    const input =
      'Cookie: session=CANARY_A; csrf=CANARY_B\nAuthorization: Basic CANARY_C\n{"token":"CANARY_D"}\nC:/Users/CANARY_E/file.txt';
    expect(prepareThorFeedback('Test', input).body).not.toMatch(/CANARY_[A-E]/);
  });
  it('is stable when the main process validates the reviewed payload', () => {
    const draft = prepareThorFeedback('Problem', 'Bearer abc123\npassword=hunter2');
    expect(prepareThorFeedback(draft.title, draft.body)).toEqual(draft);
  });
  it('bounds the submitted title and body', () => {
    const draft = prepareThorFeedback('x'.repeat(201), 'y'.repeat(10001));
    expect(draft.title).toHaveLength(200);
    expect(draft.body).toHaveLength(10000);
  });
});
