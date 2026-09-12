// Prep-sheet storage and validation. Sheets are keyed per student and subject
// (what "you should play" depends on who you are); a bare subject key is a sheet
// from before that, shared with everyone. Generated items are checked against
// the evidence ids the prompt issued so the sheet cannot cite what it was not
// given, and an item citing nothing is flagged rather than dropped.
import { DEFAULT_USER } from './store.js';

export const sheetKey = (uid, subject) => `${uid}|${subject}`;

/** The sheet a viewer should see: their own, else the primary member's (prep
 * sheets are shared reading for the club), else the legacy shared one. */
export function readSheet(sheets, uid, subject) {
  return sheets[sheetKey(uid, subject)] || sheets[sheetKey(DEFAULT_USER, subject)] || sheets[subject] || null;
}

/** Keep only evidence ids that exist; flag items with none as unsupported. A
 * plain string (an older or off-schema reply) becomes an unsupported item. */
export function validateSheet(output, evidence) {
  const ids = new Set(Object.keys(evidence || {}));
  const clean = (list, textKey) => (Array.isArray(list) ? list : []).map(item => {
    if (typeof item === 'string') return { [textKey]: item, evidence: [], unsupported: true };
    const ev = [...new Set((Array.isArray(item.evidence) ? item.evidence : []).map(String).filter(id => ids.has(id)))];
    return { ...item, evidence: ev, unsupported: ev.length === 0 };
  });
  return {
    headline: String(output?.headline || ''),
    profile: output?.profile || {},
    exploit_plan: clean(output?.exploit_plan, 'step'),
    openings: clean(output?.openings, 'when'),
    watch_fors: clean(output?.watch_fors, 'cue'),
  };
}

const evNote = (ids, evidence) => (ids?.length ? ` [${ids.join(', ')}]` : ' [unsupported]');

/** The sheet as one-page markdown (for a coach, a printout, or a phone note),
 * with the cited evidence as footnotes. Works for the legacy free-text sheets too. */
export function buildScoutCard(subject, sheet, headToHead = null) {
  const out = [`# Preparation sheet: ${subject}`, ''];
  out.push(`From ${sheet.games ?? '?'} analysed game${sheet.games === 1 ? '' : 's'}${sheet.createdAt ? `, generated ${String(sheet.createdAt).slice(0, 10)}` : ''}.`);
  if (headToHead?.record?.games) {
    const r = headToHead.record;
    out.push('', `Head to head: ${r.games} game${r.games === 1 ? '' : 's'}, ${r.wins}W ${r.draws}D ${r.losses}L${r.scorePct != null ? ` (${r.scorePct}%)` : ''}.`);
  }
  if (sheet.headline) out.push('', `**${sheet.headline}**`);
  const p = sheet.profile || {};
  const rows = [['Style', p.style], ['Strongest phase', p.strongest_phase], ['Weakest phase', p.weakest_phase], ['Main errors', p.main_errors], ['Time trouble', p.time_trouble]].filter(([, v]) => v);
  if (rows.length) { out.push('', '## Profile', ''); for (const [k, v] of rows) out.push(`- ${k}: ${v}`); }
  const ev = sheet.evidence || {};
  const plan = Array.isArray(sheet.exploit_plan) ? sheet.exploit_plan : (sheet.exploit_plan ? [sheet.exploit_plan] : []);
  if (plan.length) { out.push('', '## Game plan', ''); plan.forEach((s, i) => out.push(`${i + 1}. ${typeof s === 'string' ? s : s.step + evNote(s.evidence, ev)}`)); }
  if (Array.isArray(sheet.openings) && sheet.openings.length) {
    out.push('', '## Openings', '', '| When | You play | Why |', '| --- | --- | --- |');
    for (const o of sheet.openings) out.push(`| ${o.when} | ${o.play} | ${o.why}${o.evidence ? evNote(o.evidence, ev) : ''} |`);
  } else if (sheet.openings_advice) out.push('', '## Openings', '', sheet.openings_advice);
  const watch = Array.isArray(sheet.watch_fors) ? sheet.watch_fors : (sheet.watch_fors ? [sheet.watch_fors] : []);
  if (watch.length) { out.push('', '## Watch for', ''); for (const w of watch) out.push(`- ${typeof w === 'string' ? w : w.cue + evNote(w.evidence, ev)}`); }
  const cited = new Set([...plan, ...(Array.isArray(sheet.openings) ? sheet.openings : []), ...watch].flatMap(x => x?.evidence || []));
  if (cited.size) {
    out.push('', '## Evidence', '');
    for (const id of [...cited].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) if (ev[id]) out.push(`- ${id}: ${ev[id].text}`);
  }
  out.push('');
  return out.join('\n');
}
