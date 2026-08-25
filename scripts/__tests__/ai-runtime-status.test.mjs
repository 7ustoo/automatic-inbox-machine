import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aiRuntimeStatus } from '../ai-runtime-status.mjs';

test('AI runtime status never exposes a provider key or throws without a check', () => {
  const status = aiRuntimeStatus('provider-that-does-not-exist');
  assert.ok(['working', 'failed', 'not_checked'].includes(status.state));
  assert.equal(JSON.stringify(status).includes('sk-ant-'), false);
});
