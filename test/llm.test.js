import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { claudeCli, complete, completeRetry, LlmError } from '../server/llm.js';

// A fake `claude` binary (test/fixtures/claude) stands in for the real CLI:
// prepending its directory to PATH makes execFile('claude', ...) resolve to
// it instead, so these exercise claudeCli()'s actual stdout/exit-code parsing
// rather than a hand-rolled substitute for it.
const FIXTURES = path.join(process.cwd(), 'test', 'fixtures');
const realPath = process.env.PATH;
test.before(() => { process.env.PATH = FIXTURES + path.delimiter + realPath; });
test.after(() => { process.env.PATH = realPath; });

const req = prompt => ({ system: 'sys', prompt, schema: { type: 'object' } });

test('claudeCli parses structured_output, cost, and model usage', async () => {
  const { output, costUsd, model } = await claudeCli(req('ANY'));
  assert.deepEqual(output, { pattern: 'ok', ply: 3 });
  assert.equal(costUsd, 0.02);
  assert.equal(model, 'claude-x');
});

test('claudeCli falls back to parsing a fenced JSON block in `result`', async () => {
  const { output, costUsd } = await claudeCli(req('FALLBACK_FENCED_JSON'));
  assert.deepEqual(output, { pattern: 'fenced' });
  assert.equal(costUsd, 0.01);
});

test('claudeCli rejects with LlmError on is_error, non-JSON stdout, no structured output, or a non-zero exit', async () => {
  await assert.rejects(claudeCli(req('FAIL_IS_ERROR')), err => err instanceof LlmError && /model refused/.test(err.message));
  await assert.rejects(claudeCli(req('FAIL_BADJSON')), err => err instanceof LlmError && /non-JSON/.test(err.message));
  await assert.rejects(claudeCli(req('FAIL_NO_OUTPUT')), err => err instanceof LlmError && /no structured output/.test(err.message));
  await assert.rejects(claudeCli(req('FAIL_NONZERO')), err => err instanceof LlmError && /rate limit/.test(err.message));
});

test('complete() dispatches to claudeCli for the default provider and rejects unknown/manual providers', async () => {
  const out = await complete({}, req('ANY'));
  assert.deepEqual(out.output, { pattern: 'ok', ply: 3 });
  await assert.rejects(complete({ llmProvider: 'manual' }, req('ANY')), LlmError);
  await assert.rejects(complete({ llmProvider: 'nonsense' }, req('ANY')), err => err instanceof LlmError && /Unknown LLM provider/.test(err.message));
});

test('completeRetry retries once on an LlmError and succeeds if the retry does', async () => {
  let calls = 0;
  const settings = {};
  const flaky = { get system() { return 'sys'; }, get prompt() { calls++; return calls === 1 ? 'FAIL_BADJSON' : 'ANY'; }, schema: { type: 'object' } };
  const out = await completeRetry(settings, flaky);
  assert.equal(calls, 2, 'failed once, retried once');
  assert.deepEqual(out.output, { pattern: 'ok', ply: 3 });
});

test('completeRetry does not retry a non-LlmError (a bug, not a transient failure)', async () => {
  const boom = { get system() { throw new TypeError('boom'); }, prompt: 'ANY', schema: {} };
  await assert.rejects(completeRetry({}, boom), TypeError);
});
