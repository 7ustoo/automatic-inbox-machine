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
  isDirectOpportunity: true,
  requiresCandidateResponse: true,
  isAutomatedJobMail: false,
  reason: 'The sender asks to arrange a conversation.',
  summary: 'The recruiter wants to schedule a conversation and asks for availability.',
  title: '',
  client: '',
  workMode: 'unknown',
  requestedProfileFields: ['linkedin', 'availability'],
  rateConfirmationRequested: false
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
  assert.deepEqual(result.fields.requestedProfileFields, ['linkedin', 'availability']);
  assert.equal(request.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(request.options.headers['x-api-key'], 'test-secret-anthropic');
});

test('AI rate-confirmation intent and a checklist at the end survive a long JD', { concurrency: false }, async () => {
  resetAiBudget();
  process.env.ANTHROPIC_API_KEY = 'test-secret-anthropic';
  let requestBody;
  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return new Response(JSON.stringify({ content: [{ type: 'tool_use', input: {
      ...verdict,
      category: 'NEW_REQ',
      isInterviewRequest: false,
      rateConfirmationRequested: true,
      requestedProfileFields: ['fullName', 'linkedin', 'workAuth']
    } }] }), { status: 200 });
  };
  const result = await classify({
    subject: 'Please confirm $85/hr',
    body: `Cloud Engineer role\n${'Long job description. '.repeat(1000)}\nFINAL CHECKLIST: Please confirm $85/hr and provide LinkedIn.`,
    from: 'recruiter@example.com', fromName: 'Recruiter'
  }, { classify: { ai: { enabled: true, provider: 'anthropic', model: 'claude-test', maxPerHour: 20, maxBodyChars: 1000 } } });
  assert.equal(result.category, 'RATE_CONFIRM');
  assert.ok(result.fields.requestedProfileFields.includes('linkedin'));
  assert.match(requestBody.messages[0].content, /FINAL CHECKLIST/);
  assert.match(requestBody.messages[0].content, /middle omitted/);
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
  assert.equal(JSON.parse(request.options.body).store, false, 'email analysis responses should not be stored by the API');
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
  assert.equal(JSON.parse(request.options.body).generation_config.thinking_level, 'minimal');
});

test('AI treats an automated single-role recommendation as a job alert, not a recruiter request', { concurrency: false }, async () => {
  resetAiBudget();
  process.env.ANTHROPIC_API_KEY = 'test-secret-anthropic';
  globalThis.fetch = async () => new Response(JSON.stringify({
    content: [{ type: 'tool_use', input: {
      category: 'NEW_REQ', confidence: 0.98, isInterviewRequest: false,
      isDirectOpportunity: false, requiresCandidateResponse: false, isAutomatedJobMail: true,
      reason: 'Saved-search recommendation without a recruiter ask.',
      summary: 'An automated saved search recommends a Cloud Engineer listing.',
      title: 'Cloud Engineer', client: '', workMode: 'remote'
    } }]
  }), { status: 200 });
  const result = await classify({
    subject: 'A new Cloud Engineer job matches your alert',
    body: 'This job may be a fit. View job. Manage your saved search.',
    from: 'jobs@jobboard.example', fromName: 'Job alerts'
  }, config('anthropic', 'claude-test'));
  assert.equal(result.category, 'JOB_ALERT');
  assert.equal(result.decidedBy, 'model');
});

test('AI refuses to make a reply draft from job-related mail with no direct ask', { concurrency: false }, async () => {
  resetAiBudget();
  process.env.OPENAI_API_KEY = 'test-secret-openai';
  globalThis.fetch = async () => new Response(JSON.stringify({
    output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({
      ...verdict,
      category: 'NEW_REQ',
      isInterviewRequest: false,
      isDirectOpportunity: false,
      requiresCandidateResponse: false,
      isAutomatedJobMail: false,
      reason: 'This is an application status receipt with no request to reply.',
      summary: 'The employer confirms the application was received and says no action is needed.'
    }) }] }]
  }), { status: 200 });

  const result = await classify({
    subject: 'We got your application',
    body: 'Thank you for applying. We received your application and will review it. No action is required.',
    from: 'careers@example.com',
    fromName: 'Careers'
  }, config('openai', 'gpt-test'));

  assert.ok(['ACK', 'RECRUITER_OTHER'].includes(result.category));
  assert.ok(!['NEW_REQ', 'RTR_REQUEST', 'RATE_CONFIRM'].includes(result.category));
  assert.match(result.summary, /application/i);
});

test('when enabled AI is unavailable, a rules-only recruiter hit stays visible but requires manual approval', { concurrency: false }, async () => {
  resetAiBudget();
  process.env.OPENAI_API_KEY = 'test-secret-openai';
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'temporary outage' } }), { status: 503 });
  const result = await classify({
    subject: 'Remote Cloud Engineer opportunity',
    body: 'I have a remote Cloud Engineer role. Please reply if interested.',
    from: 'recruiter@example.com',
    fromName: 'Recruiter'
  }, config('openai', 'gpt-test'));
  assert.equal(result.category, 'NEW_REQ');
  assert.equal(result.decidedBy, 'rules-failsafe');
  assert.match(result.reason, /manual approval/i);
});
