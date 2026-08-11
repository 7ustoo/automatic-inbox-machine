import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, resetAiBudget } from '../classify.mjs';
import { providerList } from '../ai-providers.mjs';

const originalFetch = globalThis.fetch;
const KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY'];

after(() => {
  globalThis.fetch = originalFetch;
  for (const key of KEYS) delete process.env[key];
});

const verdict = {
  category: 'INTERVIEW',
  confidence: 0.96,
  isInterviewRequest: true,
  reason: 'The sender asks to arrange a conversation.',
  title: '',
  client: '',
  workMode: 'unknown'
};

function config(provider, model) {
  return {
    classify: {
      ai: { enabled: true, provider, model, maxPerHour: 20, maxBodyChars: 6000 },
      extraRejectionPhrases: [],
      extraInterviewPhrases: []
    }
  };
}

const message = {
  subject: 'Following up',
  body: 'We reviewed your application and would like to continue. Please respond when convenient.',
  from: 'recruiter@example.com',
  fromName: 'Recruiter'
};

test('provider metadata links users directly to all three key pages without exposing keys', () => {
  const providers = providerList();
  assert.deepEqual(providers.map((provider) => provider.id), ['anthropic', 'openai', 'gemini']);
  for (const provider of providers) assert.match(provider.keyUrl, /^https:\/\//);
  assert.equal(JSON.stringify(providers).includes('test-secret'), false);
});

test('Claude can override an ambiguous rules verdict', { concurrency: false }, async () => {
  resetAiBudget();
  process.env.ANTHROPIC_API_KEY = 'test-secret-anthropic';
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ content: [{ type: 'tool_use', input: verdict }], usage: { input_tokens: 10 } }), { status: 200 });
  };
  const result = await classify(message, config('anthropic', 'claude-test'));
  assert.equal(result.category, 'INTERVIEW');
  assert.equal(result.decidedBy, 'model');
  assert.equal(request.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(request.options.headers['x-api-key'], 'test-secret-anthropic');
});

test('OpenAI Responses structured output can classify the same message', { concurrency: false }, async () => {
  resetAiBudget();
  process.env.OPENAI_API_KEY = 'test-secret-openai';
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({
      output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(verdict) }] }],
      usage: { input_tokens: 10 }
    }), { status: 200 });
  };
  const result = await classify(message, config('openai', 'gpt-test'));
  assert.equal(result.category, 'INTERVIEW');
  assert.equal(result.decidedBy, 'model');
  assert.equal(request.url, 'https://api.openai.com/v1/responses');
  assert.equal(request.options.headers.authorization, 'Bearer test-secret-openai');
});

test('Gemini structured output can classify the same message', { concurrency: false }, async () => {
  resetAiBudget();
  process.env.GEMINI_API_KEY = 'test-secret-gemini';
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({
      steps: [{ type: 'model_output', content: [{ type: 'text', text: JSON.stringify(verdict) }] }],
      usage: { input_tokens: 10 }
    }), { status: 200 });
  };
  const result = await classify(message, config('gemini', 'gemini-test'));
  assert.equal(result.category, 'INTERVIEW');
  assert.equal(result.decidedBy, 'model');
  assert.equal(request.url, 'https://generativelanguage.googleapis.com/v1beta/interactions');
  assert.equal(request.options.headers['x-goog-api-key'], 'test-secret-gemini');
});
