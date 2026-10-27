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
  it('redacts UNC paths, JSON-escaped paths and file URLs in both fields', () => {
    const unc = '\\\\CANARY_SERVER\\CANARY_SHARE\\report final.docx';
    const input = [
      unc,
      JSON.stringify({ path: unc }),
      'file://CANARY_HOST/CANARY_SHARE/report.docx',
      'file:///C:/Users/CANARY_USER/report.docx',
    ].join('\n');
    const draft = prepareThorFeedback(input, input);
    expect(draft.title).not.toMatch(/CANARY_/);
    expect(draft.body).not.toMatch(/CANARY_/);
    expect(draft.body).toContain('{"path":"[REDACTED PATH]"}');
    expect(prepareThorFeedback(draft.title, draft.body)).toEqual(draft);
    expect(prepareThorFeedback('Normal title', 'Normal text without a path.')).toEqual({
      title: 'Normal title',
      body: 'Normal text without a path.',
    });
  });
  it('redacts path segments containing commas and apostrophes without exposing their tails', () => {
    const unc = "\\\\SERVER\\share\\Budget,CANARY_FINANCE's.xlsx";
    const input = [unc, JSON.stringify({ path: unc }), "file://SERVER/share/O'CANARY_PRIVATE,report.docx"].join('\n');
    const draft = prepareThorFeedback(input, input);
    expect(draft.title).not.toMatch(/CANARY_/);
    expect(draft.body).not.toMatch(/CANARY_/);
    expect(draft.body).toContain('{"path":"[REDACTED PATH]"}');
    expect(prepareThorFeedback(draft.title, draft.body)).toEqual(draft);
  });
  it('redacts UNC server roots and forward-slash UNC shares without changing ordinary URLs', () => {
    const input = '\\\\CANARY_SERVER\n//CANARY_HOST/share/CANARY_FILE.txt';
    const draft = prepareThorFeedback(input, input);
    expect(draft.title).not.toMatch(/CANARY_/);
    expect(draft.body).not.toMatch(/CANARY_/);
    expect(prepareThorFeedback(draft.title, draft.body)).toEqual(draft);
    expect(prepareThorFeedback('Test', 'https://example.test/path').body).toBe('[REDACTED URL]');
    expect(prepareThorFeedback('Test', 'ftp://example.test/path').body).toBe('ftp://example.test/path');
  });
  it('redacts JSON slash-escaped file URLs', () => {
    const input = JSON.stringify({ path: 'file://CANARY_SERVER/CANARY_SHARE/report.docx' }).replaceAll('/', '\\/');
    const draft = prepareThorFeedback(input, input);
    expect(draft.title).not.toMatch(/CANARY_/);
    expect(draft.body).toBe('{"path":"[REDACTED PATH]"}');
    expect(prepareThorFeedback(draft.title, draft.body)).toEqual(draft);
  });
  it('bounds the submitted title and body', () => {
    const draft = prepareThorFeedback('x'.repeat(201), 'y'.repeat(10001));
    expect(draft.title).toHaveLength(200);
    expect(draft.body).toHaveLength(10000);
  });
});
