// LLM providers. Default: the local `claude` CLI (subscription, no API key).
// 'manual' returns the prompt so the user can paste it into any assistant and paste the JSON back.
import { execFile } from 'node:child_process';
import os from 'node:os';

export class LlmError extends Error {}

/** Turn a raw CLI failure into a message the person at the screen can act on.
 * The common cases have known shapes: a missing binary (ENOENT), a hung call
 * (execFile kills at timeoutMs), the subscription usage limit ("Claude AI
 * usage limit reached|<epoch>" with the reset time), a signed-out CLI, and a
 * transient overload. Anything unrecognised keeps the raw detail. Exported
 * for the tests. */
export function classifyCliFailure(detail, err, timeoutMs) {
  const d = String(detail || '');
  if (err?.code === 'ENOENT') {
    return new LlmError('The claude CLI is not installed or not on PATH. Install Claude Code and sign in once, or switch the LLM provider to manual in Settings.');
  }
  if (err?.killed || err?.signal === 'SIGTERM') {
    return new LlmError(`The claude CLI did not respond within ${Math.round((timeoutMs || 0) / 1000)}s and was stopped. It may be offline or busy; this call is retried once automatically, so try again in a few minutes if the error persists.`);
  }
  const lim = d.match(/usage limit reached\|?(\d{10,13})?/i);
  if (lim || /rate.?limit|quota exceeded|out of extra usage/i.test(d)) {
    const raw = lim?.[1];
    const reset = raw ? new Date(+raw * (raw.length === 10 ? 1000 : 1)) : null;
    return new LlmError(`Claude subscription usage limit reached${reset ? `; it resets around ${reset.toLocaleString()}` : ' (it resets on a rolling schedule, usually within a few hours)'}. Nothing is lost: retry the failed jobs or buttons after the reset.`);
  }
  if (/not logged in|logged out|please log ?in|invalid api key|authentication|unauthorized/i.test(d)) {
    return new LlmError('The claude CLI is signed out. Run `claude` in a terminal, complete the sign-in, and retry.');
  }
  if (/overloaded|529/i.test(d)) {
    return new LlmError('Claude is temporarily overloaded. This call is retried once automatically; try again in a few minutes if the error persists.');
  }
  return new LlmError(`claude CLI failed: ${d.slice(0, 500)}`);
}

/** Run `claude -p` with a system prompt and a JSON schema; returns the parsed structured output. */
export function claudeCli({ system, prompt, schema, model, timeoutMs = 180000 }) {
  const args = [
    '-p', prompt,
    '--output-format', 'json',
    '--tools', '',
    '--no-session-persistence',
    '--system-prompt', system,
    '--json-schema', JSON.stringify(schema),
  ];
  if (model) args.push('--model', model);
  return new Promise((resolve, reject) => {
    execFile('claude', args, { cwd: os.tmpdir(), maxBuffer: 10 * 1024 * 1024, timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        const detail = (stderr || stdout || err.message).toString().slice(0, 500);
        return reject(classifyCliFailure(detail, err, timeoutMs));
      }
      let data;
      try { data = JSON.parse(stdout); } catch { return reject(new LlmError('claude CLI returned non-JSON output: ' + stdout.slice(0, 300))); }
      // The usage limit usually arrives this way: exit 0, is_error true, and
      // the reset time in the result text.
      if (data.is_error) return reject(classifyCliFailure(data.result || 'unknown error', null, timeoutMs));
      const out = data.structured_output || tryParse(data.result);
      if (!out) return reject(new LlmError('claude CLI returned no structured output: ' + (data.result || '').slice(0, 300)));
      resolve({ output: out, costUsd: data.total_cost_usd ?? null, model: Object.keys(data.modelUsage || {}).join(',') });
    });
  });
}

function tryParse(text) {
  if (!text) return null;
  const cleaned = text.replace(/^```(?:json)?\s*/m, '').replace(/```\s*$/m, '').trim();
  try { return JSON.parse(cleaned); } catch { return null; }
}

/** Provider dispatch. Returns { output, costUsd, model } or throws.
 * `timeoutMs` widens the default for long calls (whole-game batches). */
export async function complete(settings, { system, prompt, schema, timeoutMs }) {
  const provider = settings.llmProvider || 'claude-cli';
  if (provider === 'claude-cli') {
    return claudeCli({ system, prompt, schema, model: settings.claudeModel || undefined, ...(timeoutMs ? { timeoutMs } : {}) });
  }
  if (provider === 'manual') {
    throw new LlmError('LLM provider is set to manual: copy the prompt from the game view and paste the JSON answer back.');
  }
  throw new LlmError(`Unknown LLM provider: ${provider}`);
}

/** One retry for transient CLI failures (timeout, malformed output); anything
 * else propagates. A minute-long call failing at moment 5 of 6 (or any other
 * single interactive request) should not fail outright when a second attempt
 * would do. Every call site should go through this rather than `complete()`
 * directly, so a transient hiccup never has to be handled ad hoc per caller. */
export async function completeRetry(settings, req) {
  try { return await complete(settings, req); } catch (err) {
    if (!(err instanceof LlmError)) throw err;
    // Back off longer for a rate/usage limit than for a transient timeout or a
    // one-off malformed reply, so the single retry is not wasted racing a cap.
    const limited = /limit|rate|quota|overloaded|429|529/i.test(err.message || '');
    await new Promise(r => setTimeout(r, limited ? 30000 : 2000));
    return complete(settings, req);
  }
}

export async function checkClaudeCli() {
  return new Promise(resolve => {
    execFile('claude', ['--version'], { timeout: 10000 }, (err, stdout) => {
      resolve(err ? { ok: false, error: err.message } : { ok: true, version: stdout.trim() });
    });
  });
}
