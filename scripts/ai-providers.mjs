import { env } from './env.mjs';
import { aiRuntimeStatus } from './ai-runtime-status.mjs';

export const AI_PROVIDERS = Object.freeze({
  anthropic: Object.freeze({
    id: 'anthropic',
    label: 'Claude (Anthropic)',
    keyEnv: 'ANTHROPIC_API_KEY',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    defaultModel: 'claude-haiku-4-5-20251001',
    placeholder: 'sk-ant-…'
  }),
  openai: Object.freeze({
    id: 'openai',
    label: 'OpenAI',
    keyEnv: 'OPENAI_API_KEY',
    keyUrl: 'https://platform.openai.com/api-keys',
    defaultModel: 'gpt-4o-mini',
    placeholder: 'sk-…'
  }),
  gemini: Object.freeze({
    id: 'gemini',
    label: 'Google Gemini',
    keyEnv: 'GEMINI_API_KEY',
    keyUrl: 'https://aistudio.google.com/app/apikey',
    defaultModel: 'gemini-3.5-flash-lite',
    placeholder: 'AQ.… or AIza…'
  })
});

export function providerFor(id = 'anthropic') {
  return AI_PROVIDERS[id] || AI_PROVIDERS.anthropic;
}

export function providerHasKey(id) {
  return Boolean(env(providerFor(id).keyEnv).trim());
}

export function providerList() {
  return Object.values(AI_PROVIDERS).map((provider) => ({
    id: provider.id,
    label: provider.label,
    keyEnv: provider.keyEnv,
    keyUrl: provider.keyUrl,
    defaultModel: provider.defaultModel,
    placeholder: provider.placeholder,
    keyPresent: providerHasKey(provider.id),
    runtime: aiRuntimeStatus(provider.id)
  }));
}

function parseJson(text) {
  const value = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return value ? JSON.parse(value) : null;
}

async function anthropicRequest({ apiKey, model, system, prompt, schema, signal }) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model,
      max_tokens: 512,
      system,
      tools: [{
        name: 'classify_recruiter_email',
        description: 'Record the classification of one recruiter or job-application email.',
        input_schema: schema
      }],
      tool_choice: { type: 'tool', name: 'classify_recruiter_email' },
      messages: [{ role: 'user', content: prompt }]
    })
  });
  const payload = await response.json().catch(() => ({}));
  return {
    ok: response.ok,
    status: response.status,
    detail: payload?.error?.message || '',
    input: (payload.content || []).find((block) => block.type === 'tool_use')?.input || null,
    usage: payload.usage || null
  };
}

async function openAiRequest({ apiKey, model, system, prompt, schema, signal }) {
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      input: [
        { role: 'system', content: system },
        { role: 'user', content: prompt }
      ],
      max_output_tokens: 700,
      store: false,
      text: {
        format: {
          type: 'json_schema',
          name: 'classify_recruiter_email',
          strict: true,
          schema
        }
      }
    })
  });
  const payload = await response.json().catch(() => ({}));
  const outputText = payload.output_text || (payload.output || [])
    .flatMap((item) => item.content || [])
    .find((item) => item.type === 'output_text')?.text;
  return {
    ok: response.ok,
    status: response.status,
    detail: payload?.error?.message || '',
    input: response.ok ? parseJson(outputText) : null,
    usage: payload.usage || null
  };
}

async function geminiRequest({ apiKey, model, system, prompt, schema, signal }) {
  const response = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': apiKey
    },
    body: JSON.stringify({
      model,
      input: `${system}\n\n${prompt}`,
      // Classification is a short, bounded extraction task. Gemini 3 models
      // think by default; minimal keeps inbox latency predictable on free-tier
      // accounts without disabling structured-output validation.
      generation_config: { thinking_level: 'minimal' },
      response_format: {
        type: 'text',
        mime_type: 'application/json',
        schema
      }
    })
  });
  const payload = await response.json().catch(() => ({}));
  const outputText = payload.output_text || (payload.steps || [])
    .filter((step) => step.type === 'model_output')
    .flatMap((step) => step.content || [])
    .find((item) => item.type === 'text')?.text;
  return {
    ok: response.ok,
    status: response.status,
    detail: payload?.error?.message || '',
    input: response.ok ? parseJson(outputText) : null,
    usage: payload.usage || payload.usage_metadata || null
  };
}

const REQUESTS = {
  anthropic: anthropicRequest,
  openai: openAiRequest,
  gemini: geminiRequest
};

export async function requestClassification({ providerId, model, system, prompt, schema, signal }) {
  const provider = providerFor(providerId);
  const apiKey = env(provider.keyEnv).trim();
  if (!apiKey) return { ok: false, status: 0, detail: `${provider.keyEnv} is not set`, input: null, usage: null };
  return REQUESTS[provider.id]({
    apiKey,
    model: model || provider.defaultModel,
    system,
    prompt,
    schema,
    signal
  });
}
