// Pool of UCI engines: the local Stockfish plus one per reachable remote host.
// No daemon and no admin access needed on the remotes: `ssh host stockfish` is
// itself a UCI engine over stdio, so the Engine class drives a remote binary
// exactly like a local one. An ssh drop looks like the process exiting, which
// the Engine class already turns into failed in-flight commands; the dispatch
// loop below then re-queues the position on the surviving engines.
import { Engine, getEngine } from './engine.js';

const SSH_OPTS = [
  '-o', 'BatchMode=yes',            // never prompt for a password; fail instead
  '-o', 'ConnectTimeout=5',
  '-o', 'ServerAliveInterval=15',   // detect dead machines mid-search
  '-o', 'ServerAliveCountMax=2',
  '-o', 'StrictHostKeyChecking=accept-new',
];
const PROBE_TIMEOUT_MS = 15000;     // ssh connect + uci handshake
const RETRY_FAILED_HOST_MS = 5 * 60 * 1000; // do not stall every job re-probing a downed host

/** The command run on the remote host. `~` expands in the remote login shell;
 * the path may be the binary itself or a directory containing Stockfish. When
 * it is a directory we take `stockfish` if present, else the first `stockfish*`
 * binary (the official release names it e.g. stockfish-linux-x86-64-universal).
 * nice -n 19: these are shared lab machines. */
export function remoteCommand(remotePath) {
  const p = remotePath || '~/stockfish';
  return `nice -n 19 sh -c 'if [ -d "$0" ]; then b="$0/stockfish"; [ -x "$b" ] || b=$(ls "$0"/stockfish* 2>/dev/null | head -n1); exec "$b"; else exec "$0"; fi' ${p}`;
}

export function sshEngine(host, settings) {
  return new Engine('ssh', {
    args: [...SSH_OPTS, host, remoteCommand(settings.remoteEnginePath)],
    threads: settings.remoteThreads || 4,
    hash: 256,
    label: host,
  });
}

export function remoteHostList(settings) {
  return (settings.remoteHosts || []).map(h => String(h).trim()).filter(Boolean);
}

/** Whether the local machine joins the analysis pool. Off by request keeps it
 * out so it only coordinates dispatch and runs the LLM explanations, offloading
 * all engine work to the remotes; but it always rejoins when no remote engine
 * is reachable, so analysis never stalls for want of an engine. The sparring
 * engine (drills, play-out) is separate and always local, so interactive
 * features stay responsive either way. */
export function shouldIncludeLocal(settings, remoteEngineCount) {
  return settings.useLocalEngine !== false || remoteEngineCount === 0;
}

// Connected remote engines and recent probe failures survive across jobs, so a
// bulk import pays the ssh handshake once per host, and a downed host (or a
// disabled VPN) costs one probe per cooldown window instead of one per job.
const remotes = new Map();      // host -> Engine (started)
const failedAt = new Map();     // host -> timestamp of last failed probe
let poolSig = '';

async function connect(host, settings) {
  try {
    const e = await sshEngine(host, settings).start(PROBE_TIMEOUT_MS);
    remotes.set(host, e);
    failedAt.delete(host);
    return { host, ok: true, name: e.name };
  } catch (err) {
    failedAt.set(host, Date.now());
    return { host, ok: false, error: err.message };
  }
}

/** Probe every configured host (ignoring the failure cooldown) and keep the
 * successful connections for the pool. Powers the settings "test hosts" button
 * and the CLI probe. Returns per-host results plus a VPN hint when everything
 * is unreachable, since that usually means the tunnel is down, not 22 dead
 * machines. */
export async function probeHosts(settings, hosts = remoteHostList(settings)) {
  const results = await Promise.all(hosts.map(async host => {
    const existing = remotes.get(host);
    if (existing?.proc) return { host, ok: true, name: existing.name };
    return connect(host, settings);
  }));
  const up = results.filter(r => r.ok).length;
  return {
    results,
    up,
    vpnHint: hosts.length >= 2 && up === 0
      ? `All ${hosts.length} remote hosts are unreachable. If they should be up, check that the VPN is connected.`
      : null,
  };
}

/** Local engine plus every reachable remote, ready to analyse. Reconnects
 * hosts that are missing from the pool unless they failed within the cooldown
 * window. Never throws for remote trouble: worst case is a local-only pool
 * with a warning attached. */
export async function getEnginePool(settings) {
  const hosts = remoteHostList(settings);
  const sig = JSON.stringify([hosts, settings.remoteThreads, settings.remoteEnginePath]);
  if (sig !== poolSig) {
    poolSig = sig;
    for (const e of remotes.values()) e.stop();
    remotes.clear();
    failedAt.clear();
  }
  for (const [host, e] of remotes) if (!e.proc) remotes.delete(host); // died since last job
  const missing = hosts.filter(h => !remotes.has(h) && Date.now() - (failedAt.get(h) || 0) > RETRY_FAILED_HOST_MS);
  if (missing.length) await Promise.all(missing.map(h => connect(h, settings)));

  const remoteEngines = hosts.map(h => remotes.get(h)).filter(e => e?.proc);
  const local = shouldIncludeLocal(settings, remoteEngines.length) ? await getEngine(settings) : null;
  const engines = [...(local ? [local] : []), ...remoteEngines];
  let warning = null;
  if (hosts.length >= 2 && !remoteEngines.length) {
    warning = settings.useLocalEngine === false
      ? `All ${hosts.length} remote engine hosts are unreachable, so this machine is analysing locally despite the local-engine switch being off. If the hosts should be up, check that the VPN is connected.`
      : `All ${hosts.length} remote engine hosts are unreachable (analysing locally only). If they should be up, check that the VPN is connected.`;
  }
  return makePool(engines, warning);
}

function makePool(engines, warning = null) {
  return {
    engines: [...engines],
    name: engines[0]?.name || 'unknown',
    names: new Set(engines.map(e => e.name).filter(Boolean)),
    warning,
    drop(engine, err) {
      this.engines = this.engines.filter(e => e !== engine);
      for (const [host, e] of remotes) if (e === engine) { remotes.delete(host); failedAt.set(host, Date.now()); }
      engine.stop();
      console.error(`engine ${engine.label} dropped from pool: ${err.message} (${this.engines.length} left)`);
    },
  };
}

/** Wrap a bare Engine so analyseGame can run against a single engine (tests,
 * callers that never configured remote hosts). */
export function singleEnginePool(engine) {
  return makePool([engine]);
}

/**
 * Work-stealing dispatch: each engine pulls the next item as soon as it goes
 * idle, so a fast machine does more positions and a slow one never gates the
 * rest. `run(engine, item)` performs the search; its failure means the ENGINE
 * is broken (transport died, timeout), so the item goes back on the queue for
 * the survivors and the engine leaves the pool. `onDone(item, result, engine)`
 * consumes a result; its failure (cancellation, store errors) stops dispatch
 * and propagates. Throws only for cancellation/onDone errors, or when every
 * engine died with items still queued.
 */
export async function poolAnalyse(pool, items, run, onDone) {
  const queue = [...items];
  let stopErr = null;
  const failures = [];
  const worker = async engine => {
    while (!stopErr && queue.length) {
      const item = queue.shift();
      let result;
      try {
        result = await run(engine, item);
      } catch (err) {
        queue.unshift(item);
        failures.push(`${engine.label}: ${err.message}`);
        pool.drop(engine, err);
        return;
      }
      if (stopErr) return;
      try {
        if (onDone) await onDone(item, result, engine);
      } catch (err) {
        stopErr = err;
        return;
      }
    }
  };
  // Rounds, not a single pass: a dying engine re-queues its item, but sibling
  // workers may already have seen an empty queue and exited. Survivors pick
  // the leftovers up on the next round.
  while (queue.length && !stopErr) {
    if (!pool.engines.length) throw new Error(`analysis stopped: all engines failed (${failures.join('; ')})`);
    await Promise.all(pool.engines.map(worker));
  }
  if (stopErr) throw stopErr;
}
