// Settings: player, engine, thresholds, LLM provider.
import { api, esc, toast } from '../api.js';

export async function settingsView(root) {
  const { settings: s } = await api.settings();
  const status = await api.status();
  root.innerHTML = `
    <h1>Settings</h1>
    <div class="grid grid-2">
      <div class="card">
        <h3 style="margin-top:0">Player</h3>
        <label class="field"><span>Player name(s)</span><input type="text" name="playerNames" value="${esc(s.playerNames.join(', '))}" placeholder="Surname, or several names separated by commas"><small>Matched case-insensitively against the White and Black PGN headers. Use the surname as it appears on tournament PGNs.</small></label>
        <label class="field"><span>Rating (for the coach's explanations)</span><input type="number" name="playerRating" value="${s.playerRating}" min="400" max="3500"></label>

        <h3>Thresholds</h3>
        <label class="field"><span>Critical moment threshold (win-probability points lost)</span><input type="number" name="momentThreshold" value="${s.momentThreshold}" min="1" max="100"><small>10 = inaccuracy, 20 = mistake, 30 = blunder in lichess terms. Lower means more moments to explain. Changing it re-scores analysed games in place (no engine or explanation re-runs).</small></label>
        <label class="field"><span>Drill threshold</span><input type="number" name="drillThreshold" value="${s.drillThreshold}" min="1" max="100"><small>Moments with at least this loss become drills; the rest become sharpeners. Changing it re-tiers existing drills.</small></label>
      </div>
      <div class="card">
        <h3 style="margin-top:0">Engine</h3>
        <p><small>${status.engineOk ? `Found: <code>${esc(status.enginePath)}</code>` : '<span style="color: var(--critical)">Stockfish not found.</span> Install with <code>brew install stockfish</code>.'}</small></p>
        <label class="field"><span>Stockfish path (blank = auto-detect)</span><input type="text" name="enginePath" value="${esc(s.enginePath)}" placeholder="/opt/homebrew/bin/stockfish"></label>
        <div class="grid grid-2">
          <label class="field"><span>Depth</span><input type="number" name="engineDepth" value="${s.engineDepth}" min="4" max="40"><small>18 is a good default; 22+ is slow.</small></label>
          <label class="field"><span>MultiPV (lines)</span><input type="number" name="engineMultiPv" value="${s.engineMultiPv}" min="1" max="6"></label>
          <label class="field"><span>Threads (0 = auto)</span><input type="number" name="engineThreads" value="${s.engineThreads}" min="0" max="64"></label>
          <label class="field"><span>Hash MB</span><input type="number" name="engineHash" value="${s.engineHash}" min="16" max="8192"></label>
        </div>

        <h3>Remote engines (ssh)</h3>
        <label class="field"><span>Remote hosts</span><textarea name="remoteHosts" rows="3" placeholder="csslab1.uwb.edu, csslab2.uwb.edu, ...">${esc(s.remoteHosts.join('\n'))}</textarea><small>Analysis positions are distributed across these hosts plus the local engine. Needs passwordless ssh (keys); hosts that are down are skipped automatically. Save settings before testing.</small></label>
        <div class="grid grid-2">
          <label class="field"><span>Stockfish path on hosts</span><input type="text" name="remoteEnginePath" value="${esc(s.remoteEnginePath)}" placeholder="~/stockfish"></label>
          <label class="field"><span>Threads per host</span><input type="number" name="remoteThreads" value="${s.remoteThreads}" min="1" max="64"></label>
        </div>
        <label class="check"><input type="checkbox" name="useLocalEngine" ${s.useLocalEngine ? 'checked' : ''}> Use this machine as an analysis engine too</label>
        <small class="muted" style="display:block;margin:-6px 0 12px">Uncheck to offload all engine work to the remote hosts; this machine only coordinates and runs the LLM explanations. It still analyses locally if no remote host is reachable.</small>
        <div class="row">
          <button id="test-hosts" ${s.remoteHosts.length ? '' : 'disabled'}>Test remote hosts</button>
          <small id="hosts-result" class="muted"></small>
        </div>

        <h3>Explanations (LLM)</h3>
        <label class="field"><span>Provider</span>
          <select name="llmProvider">
            <option value="claude-cli" ${s.llmProvider === 'claude-cli' ? 'selected' : ''}>claude CLI (local, subscription, no API key)</option>
            <option value="manual" ${s.llmProvider === 'manual' ? 'selected' : ''}>Manual copy and paste</option>
          </select>
          <small>${status.claude.ok && !status.claude.skipped ? `claude CLI found: ${esc(status.claude.version)}` : (s.llmProvider === 'claude-cli' ? '<span style="color: var(--critical)">claude CLI not found on PATH.</span>' : '')}</small>
        </label>
        <label class="field"><span>Claude model (blank = CLI default)</span><input type="text" name="claudeModel" value="${esc(s.claudeModel)}" placeholder="e.g. sonnet, opus, haiku"><small>Each moment is one call of roughly 2k input tokens; the default model takes about a minute per moment. Haiku is faster and cheaper, with shallower explanations.</small></label>
        <label class="check"><input type="checkbox" name="autoExplain" ${s.autoExplain ? 'checked' : ''}> Explain moments automatically after engine analysis</label>
      </div>
    </div>
    <div class="row" style="margin-top: 16px">
      <button class="primary" id="save">Save settings</button>
      <small class="muted">Data folder: <code>${esc(status.dataDir)}</code></small>
    </div>`;

  const testBtn = root.querySelector('#test-hosts');
  testBtn.onclick = async () => {
    const out = root.querySelector('#hosts-result');
    testBtn.disabled = true;
    out.textContent = 'Testing (up to 15 seconds per unreachable host)...';
    try {
      const r = await api.testHosts();
      const downList = r.results.filter(x => !x.ok).map(x => `${x.host}: ${x.error}`);
      out.textContent = `${r.up} of ${r.results.length} hosts reachable.`
        + (r.vpnHint ? ` ${r.vpnHint}` : '')
        + (downList.length && !r.vpnHint ? ` Down: ${downList.join('; ')}` : '');
    } catch (err) { out.textContent = err.message; }
    testBtn.disabled = false;
  };

  root.querySelector('#save').onclick = async () => {
    const patch = {};
    root.querySelectorAll('[name]').forEach(el => { patch[el.name] = el.type === 'checkbox' ? el.checked : el.value; });
    try {
      const r = await api.saveSettings(patch);
      toast(r.recomputed
        ? `Settings saved. ${r.recomputed} game${r.recomputed === 1 ? '' : 's'} re-scored at the new threshold; new moments appear unexplained until the next explain run.`
        : 'Settings saved');
    } catch (err) { toast(err.message, true); }
  };
}
