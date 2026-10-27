import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../../host/aioncore/crates/aionui-app/assets/builtin-skills/', import.meta.url);
const skills = [
  'auto-inject/officecli', 'officecli-academic-paper', 'officecli-data-dashboard',
  'officecli-docx', 'officecli-financial-model', 'officecli-pitch-deck',
  'officecli-pptx', 'officecli-word-form', 'officecli-xlsx', 'morph-ppt', 'morph-ppt-3d',
];

test('Office skills use only the verified Thor tool and never recommend remote installation', async () => {
  for (const skill of skills) {
    const text = await readFile(new URL(`${skill}/SKILL.md`, root), 'utf8');
    assert.match(text, /THOR_OFFICECLI_STATUS=verified/, skill);
    assert.match(text, /THOR_OFFICECLI_PATH/, skill);
    assert.match(text, /OFFICECLI_SKIP_UPDATE=1/, skill);
    assert.match(text, /never download, install, update, or fall back to a PATH executable/i, skill);
    assert.match(text, /replace each invocation with the corresponding exact-path form/i, skill);
    assert.doesNotMatch(text, /d\.officecli\.ai|github\.com\/iOfficeAI\/OfficeCLI\/releases/i, skill);
  }
});
