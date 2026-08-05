/**
 * CI guardrail: the shipped defaults must be the safe ones.
 *
 * A release that defaults to sending mail on the user's behalf without asking is
 * a different product from the one documented. This fails the build rather than
 * trusting review to notice a one-character change in a JSON file.
 */
import { readFileSync } from 'node:fs';
import { DEFAULTS } from '../scripts/config-rw.mjs';

const example = JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));

const checks = [
  ['config.example.json policy.autoSend.enabled is false', example.policy?.autoSend?.enabled === false],
  ['config.example.json policy.approvals.enabled is true', example.policy?.approvals?.enabled === true],
  ['config.example.json paused is false', example.paused === false],
  ['DEFAULTS.policy.autoSend.enabled is false', DEFAULTS.policy.autoSend.enabled === false],
  ['DEFAULTS.policy.approvals.enabled is true', DEFAULTS.policy.approvals.enabled === true],
  ['DEFAULTS.policy.minConfidence is at least 0.8', Number(DEFAULTS.policy.minConfidence) >= 0.8],
  ['DEFAULTS.paused is false', DEFAULTS.paused === false],
  ['DEFAULTS.classify.ai.enabled is false (opt-in, not opt-out)', DEFAULTS.classify.ai.enabled === false],
  ['DEFAULTS.dedupe.autoReplyToDuplicates is false', DEFAULTS.dedupe.autoReplyToDuplicates === false]
];

let failed = false;
for (const [label, ok] of checks) {
  process.stdout.write(`${ok ? '  ok  ' : ' FAIL '} ${label}\n`);
  if (!ok) {
    process.stdout.write(`::error::${label} — this default is not safe to ship\n`);
    failed = true;
  }
}

process.exit(failed ? 1 : 0);
