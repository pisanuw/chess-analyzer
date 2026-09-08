// LLM providers. Default: the local `claude` CLI (subscription, no API key).
// 'manual' returns the prompt so the user can paste it into any assistant and paste the JSON back.
import { execFile } from 'node:child_process';
import os from 'node:os';

export class LlmError extends Error {}

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
        return reject(new LlmError(`claude CLI failed: ${detail}`));
      }
      let data;
      try { data = JSON.parse(stdout); } catch { return reject(new LlmError('claude CLI returned non-JSON output: ' + stdout.slice(0, 300))); }
      if (data.is_error) return reject(new LlmError('claude CLI error: ' + (data.result || '').slice(0, 300)));
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

export async function checkClaudeCli() {
  return new Promise(resolve => {
    execFile('claude', ['--version'], { timeout: 10000 }, (err, stdout) => {
      resolve(err ? { ok: false, error: err.message } : { ok: true, version: stdout.trim() });
    });
  });
}
