// Prompt construction for the explanation step. Everything the model sees is engine-grounded.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { formatEval, spentPerMove } from '../public/shared.js';

const sanLine = ms => ms.map(x => (x.color === 'white' ? `${x.moveNumber}.` : '') + x.san).join(' ');

// PGN header and subject text is user-controlled and interpolated into prompts
// verbatim; collapse whitespace and cap length so a crafted player name cannot
// inject instructions or bloat the prompt. (execFile, --tools "", and a strict
// --json-schema already bound the blast radius; this keeps the copy clean.)
const field = (s, max = 80) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max) || '?';

const conceptsBlock = concepts => concepts?.length ? `

Concept names already used for this player (reuse one verbatim if it fits, so study topics aggregate; otherwise coin a new short phrase):
${concepts.map(c => `- ${c}`).join('\n')}` : '';

const patternsBlock = patterns => patterns?.length ? `

Pattern names already in this player's library (reuse one verbatim if it fits, so recurring weaknesses aggregate; otherwise coin a new short name):
${patterns.map(p => `- ${p}`).join('\n')}` : '';

const weaknessBlock = (subject, patterns) => patterns?.length ? `

Weakness names already recorded for ${subject} (reuse one verbatim if it fits, so their recurring weaknesses aggregate; otherwise coin a new short name):
${patterns.map(p => `- ${p}`).join('\n')}` : '';

export const CATEGORIES = [
  'tactics-allowed',    // overlooked the opponent's tactic or threat
  'tactics-missed',     // missed a winning tactic that was available
  'calculation',        // saw the right idea but miscalculated a line
  'positional',         // wrong plan, piece placement, pawn structure, exchanges
  'opening',            // theory or known-structure error in the opening
  'endgame-technique',  // known endgame technique error
  'conversion',         // failed to convert a clearly winning position
  'defence',            // failed to find the best defensive resource in a worse position
];

export const EXPLANATION_SCHEMA = {
  type: 'object',
  properties: {
    pattern: { type: 'string', description: 'Short name for the recurring pattern, 2 to 6 words, reusable across games (e.g. "Hanging piece after exchange", "Wrong rook", "Passive king in rook endgame")' },
    category: { type: 'string', enum: CATEGORIES },
    time_pressure: { type: 'boolean', description: 'true only if the clock data makes time trouble a likely factor' },
    explanation: { type: 'string', description: 'One paragraph, at most 120 words, for a 2000-rated player: why the played move fails and why the engine line works, citing only the given lines' },
    key_question: { type: 'string', description: 'The single question the player should have asked before moving' },
    concept: { type: 'string', description: 'The general chess concept to study, one phrase' },
  },
  required: ['pattern', 'category', 'time_pressure', 'explanation', 'key_question', 'concept'],
};

export const SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'Three to five sentences on how the game went for the player' },
    lesson: { type: 'string', description: 'The one thing to take away from this game, one or two sentences' },
    opening_note: { type: 'string', description: 'One sentence on the opening: name it if recognisable and say whether the player left known paths early' },
  },
  required: ['summary', 'lesson', 'opening_note'],
};

// Scout explanations reuse the EXPLANATION_SCHEMA field names so storage and UI
// are identical; only the descriptions (and the prompt) change perspective.
export const SCOUT_EXPLANATION_SCHEMA = {
  type: 'object',
  properties: {
    pattern: { type: 'string', description: 'Short name for the opponent\'s recurring weakness, 2 to 6 words, reusable across their games (e.g. "Grabs pawns under attack", "Passive rook in endgames")' },
    category: { type: 'string', enum: CATEGORIES },
    time_pressure: { type: 'boolean', description: 'true only if the clock data makes time trouble a likely factor for the opponent' },
    explanation: { type: 'string', description: 'One paragraph, at most 120 words, for the student preparing against this opponent: what the opponent\'s move gets wrong and, concretely, how the engine line punishes it, citing only the given lines' },
    key_question: { type: 'string', description: 'The cue the student should watch for at the board to recognise or induce this kind of error from the opponent' },
    concept: { type: 'string', description: 'The exploitation idea to study, one phrase' },
  },
  required: ['pattern', 'category', 'time_pressure', 'explanation', 'key_question', 'concept'],
};

/** Schema for a whole game's explanations in one call: one entry per moment,
 * each carrying the ply it belongs to. */
export function batchExplanationSchema(scout = false) {
  const item = scout ? SCOUT_EXPLANATION_SCHEMA : EXPLANATION_SCHEMA;
  return {
    type: 'object',
    properties: {
      explanations: {
        type: 'array',
        items: {
          type: 'object',
          properties: { ply: { type: 'number', description: 'The ply number of this moment, exactly as given in the prompt' }, ...item.properties },
          required: ['ply', ...item.required],
        },
      },
    },
    required: ['explanations'],
  };
}

// The sheet is read at the board, so it is structured (a headline, a fixed-row
// profile table, a numbered plan, an openings table, cue bullets) rather than
// four prose blobs. Full style and field guidance lives in prompts/prep-sheet.md;
// keep the field names here in sync with that file.
export const PREP_SHEET_SCHEMA = {
  type: 'object',
  properties: {
    headline: { type: 'string', description: 'One short sentence: the single most useful thing to know before the game' },
    profile: {
      type: 'object',
      description: 'Quick-facts table with the same rows for every opponent, so two players can be compared at a glance. A few words per value, grounded in the data.',
      properties: {
        style: { type: 'string', description: 'How they play, in a few words (e.g. "aggressive, tactical")' },
        strongest_phase: { type: 'string', description: 'Opening, middlegame, or endgame, from the phase accuracies, a few words' },
        weakest_phase: { type: 'string', description: 'The phase where they go wrong most, from the phase accuracies, a few words' },
        main_errors: { type: 'string', description: 'Their most common error types, from the error-type counts, a few words' },
        time_trouble: { type: 'string', description: 'How they handle the clock in a few words, or "no clock data"' },
      },
      required: ['style', 'strongest_phase', 'weakest_phase', 'main_errors', 'time_trouble'],
    },
    exploit_plan: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 5, description: 'Numbered game-plan steps in order, each one short action sentence in active voice' },
    openings: {
      type: 'array',
      description: 'Opening advice as one row per line, so it scans quickly. Reference their actual lines only.',
      items: {
        type: 'object',
        properties: {
          when: { type: 'string', description: 'Their colour and line, e.g. "As Black in the Sveshnikov"' },
          play: { type: 'string', description: 'What you should play against it, short' },
          why: { type: 'string', description: 'One short reason, from their scores or where their prep ends' },
        },
        required: ['when', 'play', 'why'],
      },
      minItems: 1, maxItems: 6,
    },
    watch_fors: { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 5, description: 'Three to five short cues to watch for during the game, one per item' },
  },
  required: ['headline', 'profile', 'exploit_plan', 'openings', 'watch_fors'],
};

// Read fresh each generation (rare, tiny file) so the .md can be tuned without a
// restart. cwd is the repo root, the same convention as server/index.js and
// server/store.js (keeps this file free of import.meta, which the CJS function
// bundle would leave empty).
function prepSheetInstructions() {
  return readFileSync(path.join(process.cwd(), 'server/prompts/prep-sheet.md'), 'utf8').trim();
}

// A short fingerprint of the current sheet format: the schema plus the editable
// instructions. Stored on each generated sheet so the UI can offer a regenerate
// when the format or wording has changed, not only when new games arrive. Edit
// prep-sheet.md and this changes, so existing sheets read as "new format".
// Returns null when the instructions file is unavailable (the read-only hosted
// mirror does not bundle it and never regenerates), so callers there skip the check.
export function prepSheetVersion() {
  try {
    return createHash('sha1').update(prepSheetInstructions() + JSON.stringify(PREP_SHEET_SCHEMA)).digest('hex').slice(0, 12);
  } catch { return null; }
}

export function scoutSystemPrompt(rating) {
  return `You are a chess coach preparing a FIDE ${rating || 2000} rated student to play against a specific opponent.
You are given the opponent's positions, the mistakes they made, and Stockfish's lines with evaluations.
Rules:
- Ground every claim in the engine lines provided. Do not invent variations, do not extend lines beyond what is given, and do not evaluate moves the engine did not list.
- Frame everything for the student's benefit: what the opponent tends to get wrong and how to punish or induce it.
- Be concrete and brief. No praise, no filler, no generic advice.
- Plain punctuation: commas, colons, and parentheses. Never use em dashes.
- Evaluations are from White's point of view; positive favours White.`;
}

const gameLine = game => `${field(game.headers.White)} vs ${field(game.headers.Black)}, ${field(game.headers.Event, 120) === '?' ? 'unknown event' : field(game.headers.Event, 120)} ${field(game.headers.Date, 20)}, result ${field(game.headers.Result, 12)}.`;

function clockText(m, game) {
  if (m.clock == null) return '';
  const mins = Math.floor(m.clock / 60), secs = m.clock % 60;
  const base = `Clock after the move: ${mins}:${String(secs).padStart(2, '0')} remaining.`;
  // Deterministic time-spent, so time_pressure is not guessed from one number.
  const spent = game?.analysis?.moves ? spentPerMove(game.analysis.moves, game.headers?.TimeControl)[m.ply - 1] : null;
  if (spent == null) return base;
  return `${base} Time spent on this move: about ${spent} seconds.`;
}

/** The per-moment context for an own-game moment: position, lines, played move,
 * loss, clock. Shared by the single and batch prompts. */
function momentSection(game, ply) {
  const moves = game.analysis.moves;
  const m = moves[ply - 1];
  const side = m.color === 'white' ? 'White' : 'Black';
  const recent = sanLine(moves.slice(Math.max(0, ply - 9), ply - 1));
  const lines = m.lines.map(l => `  ${l.multipv}. ${l.san.join(' ')} (eval ${formatEval(l.cp)})`).join('\n');
  const playedRank = m.playedRank ? `This was the engine's line number ${m.playedRank}.` : 'This move is not among the engine\'s top lines.';
  const nextMove = moves[ply]; // opponent's reply / the position right after the played move
  // The engine's lines from the reply position are what the played move now
  // allows (or leaves for the opponent): the concrete threat behind a
  // tactics-allowed or defence verdict, grounded rather than guessed.
  const afterLines = nextMove?.lines?.length
    ? `\nEngine lines after ${m.san} (${nextMove.color === 'white' ? 'White' : 'Black'} to move, what it allows or leaves):\n${nextMove.lines.map(l => `  ${l.multipv}. ${l.san.join(' ')} (eval ${formatEval(l.cp)})`).join('\n')}`
    : '';
  return `Recent moves before the critical moment: ${recent || '(start of game)'}

Position before the move (FEN): ${m.fenBefore}
Phase: ${m.phase}. Move ${m.moveNumber}, ${side} to move. Engine evaluation before the move: ${formatEval(m.evalBefore)}.

Engine top lines from this position (${side} to move):
${lines}

Move played by ${side}: ${m.san}. Evaluation after it: ${formatEval(m.evalAfter)}. ${playedRank}
${nextMove ? `The opponent replied ${nextMove.san}.` : ''}${afterLines}
Win-probability lost by this move: ${m.loss} points (${m.judgment}). ${clockText(m, game)}`;
}

/** The per-moment context for a scouted mistake, including the punishment lines. */
function scoutSection(game, ply) {
  const moves = game.analysis.moves;
  const m = moves[ply - 1];
  const side = m.color === 'white' ? 'White' : 'Black';
  const subject = field(game.subject || game.headers[side] || 'the opponent');
  const recent = sanLine(moves.slice(Math.max(0, ply - 9), ply - 1));
  const lines = m.lines.map(l => `  ${l.multipv}. ${l.san.join(' ')} (eval ${formatEval(l.cp)})`).join('\n');
  const next = moves[ply]; // the reply position: how the punishment starts
  const punishLines = next?.lines?.length ? `\nEngine lines AFTER the mistake (${next.color === 'white' ? 'White' : 'Black'} to move, the punishment):\n${next.lines.map(l => `  ${l.multipv}. ${l.san.join(' ')} (eval ${formatEval(l.cp)})`).join('\n')}\n` : '';
  return `Recent moves before the mistake: ${recent || '(start of game)'}

Position before their move (FEN): ${m.fenBefore}
Phase: ${m.phase}. Move ${m.moveNumber}, ${side} to move. Evaluation: ${formatEval(m.evalBefore)}.

Engine top lines from this position (${side} to move):
${lines}

${subject} played ${m.san}. Evaluation after it: ${formatEval(m.evalAfter)}. Win-probability lost: ${m.loss} points (${m.judgment}). ${clockText(m, game)}
${punishLines}`;
}

/** Build the user prompt for one critical moment. `knownPatterns` are pattern names already used for this player. */
export function momentPrompt(game, ply, knownPatterns = [], knownConcepts = []) {
  const moves = game.analysis.moves;
  const m = moves[ply - 1];
  const side = m.color === 'white' ? 'White' : 'Black';
  const playerName = field(game.headers[side] || side);
  return `Game: ${gameLine(game)}
The player being coached is ${playerName} (${side}), rated about ${game.playerRating || 2000}.

Opening moves: ${sanLine(moves.slice(0, 20))}

${momentSection(game, ply)}

Explain why ${m.san} is classified as ${m.judgment === 'inaccuracy' ? 'an' : 'a'} ${m.judgment} and what the engine's first choice ${m.bestSan} achieves instead, using only the lines above. Then classify the error.${patternsBlock(knownPatterns)}${conceptsBlock(knownConcepts)}`;
}

/** All of a game's unexplained moments in ONE prompt: the shared game context
 * is stated once, then each moment's section. Pairs with batchExplanationSchema. */
export function momentsBatchPrompt(game, plies, knownPatterns = [], knownConcepts = []) {
  const moves = game.analysis.moves;
  const side = game.playerColor === 'white' ? 'White' : 'Black';
  const playerName = field(game.headers[side] || side);
  const sections = plies.map((ply, i) => `=== Moment ${i + 1} of ${plies.length} (ply ${ply}) ===
${momentSection(game, ply)}`).join('\n\n');
  return `Game: ${gameLine(game)}
The player being coached is ${playerName} (${side}), rated about ${game.playerRating || 2000}.

Opening moves: ${sanLine(moves.slice(0, 20))}

There are ${plies.length} critical moments to explain, listed below. Each is independent: when explaining a moment, use only that moment's lines.

${sections}

For each moment: explain why the played move is classified as it is and what the engine's first choice achieves instead, then classify the error. Return exactly one entry in the explanations array per moment, carrying its ply number as given in the heading.${patternsBlock(knownPatterns)}${conceptsBlock(knownConcepts)}`;
}

/** Scout variant of momentPrompt: same engine grounding, exploitation framing. */
export function scoutMomentPrompt(game, ply, knownPatterns = [], knownConcepts = []) {
  const moves = game.analysis.moves;
  const m = moves[ply - 1];
  const side = m.color === 'white' ? 'White' : 'Black';
  const subject = field(game.subject || game.headers[side] || 'the opponent');
  return `You are scouting ${subject}, who played ${side} in this game: ${gameLine(game)}

Opening moves: ${sanLine(moves.slice(0, 20))}

${scoutSection(game, ply)}
Explain what ${m.san} gets wrong and, concretely, how the student punishes it using the lines above. Then classify the error and give the cue that signals this weakness is in play.${weaknessBlock(subject, knownPatterns)}${conceptsBlock(knownConcepts)}`;
}

/** Scout variant of momentsBatchPrompt: every mistake of the subject in one call. */
export function scoutMomentsBatchPrompt(game, plies, knownPatterns = [], knownConcepts = []) {
  const moves = game.analysis.moves;
  const side = game.playerColor === 'white' ? 'White' : 'Black';
  const subject = field(game.subject || game.headers[side] || 'the opponent');
  const sections = plies.map((ply, i) => `=== Mistake ${i + 1} of ${plies.length} (ply ${ply}) ===
${scoutSection(game, ply)}`).join('\n\n');
  return `You are scouting ${subject}, who played ${side} in this game: ${gameLine(game)}

Opening moves: ${sanLine(moves.slice(0, 20))}

There are ${plies.length} mistakes by ${subject} to explain, listed below. Each is independent: when explaining a mistake, use only that mistake's lines.

${sections}

For each mistake: explain what the move gets wrong and, concretely, how the student punishes it using only that mistake's lines, then classify the error and give the cue that signals the weakness is in play. Return exactly one entry in the explanations array per mistake, carrying its ply number as given in the heading.${weaknessBlock(subject, knownPatterns)}${conceptsBlock(knownConcepts)}`;
}

/** Scout variant of the game summary: how the subject plays and how to face them. */
export function scoutGameSummaryPrompt(game) {
  const s = game.analysis.summary;
  const side = game.playerColor === 'white' ? 'White' : 'Black';
  const subject = field(game.subject || 'the opponent');
  const p = s[game.playerColor];
  const moments = s.moments.map(ply => {
    const m = game.analysis.moves[ply - 1];
    const e = game.explanations?.[ply];
    return `- Move ${m.moveNumber}${m.color === 'white' ? '.' : '...'} ${m.san} (${m.judgment}, ${m.phase}, eval ${formatEval(m.evalBefore)} to ${formatEval(m.evalAfter)}, engine preferred ${m.bestSan})` + (e ? ` : ${e.category}, "${e.pattern}"` : '');
  }).join('\n');
  const allMoves = sanLine(game.analysis.moves);
  return `You are scouting ${subject}, who played ${side} in this game: ${field(game.headers.White)} vs ${field(game.headers.Black)}, ${field(game.headers.Event, 120)} ${field(game.headers.Date, 20)}, result ${field(game.headers.Result, 12)}.
Their accuracy ${p.accuracy}%, average centipawn loss ${p.acpl}, ${p.inaccuracies} inaccuracies, ${p.mistakes} mistakes, ${p.blunders} blunders.

Moves: ${allMoves}

${subject}'s mistakes (engine-flagged):
${moments || '- none'}

Write: summary (how ${subject} handled this game and where they went wrong), lesson (the one thing the student should exploit when facing them), opening_note (what ${subject} played and whether leaving it early would help; name the opening only if confident).`;
}

/** One-page preparation sheet for a subject, from their aggregated dossier. */
export function prepSheetPrompt(subjectName, report, repertoire) {
  const subject = field(subjectName);
  const cats = Object.entries(report.byCategory).filter(([k, v]) => k !== 'unexplained' && v.count).map(([k, v]) => `- ${k}: ${v.count} moments (weight ${v.weight})`).join('\n');
  const phases = ['opening', 'middlegame', 'endgame'].map(ph => { const p = report.byPhase[ph]; return `- ${ph}: accuracy ${p.accuracy ?? 'n/a'}%, ${p.momentsPer100 ?? 'n/a'} moments per 100 moves`; }).join('\n');
  const pats = report.patterns.slice(0, 10).map(p => `- "${p.pattern}" (${p.count}x)`).join('\n');
  const lines = repertoire.map(l => `- as ${l.color}: ${l.line.map((s, i) => (i % 2 === 0 ? `${i / 2 + 1}.` : '') + s).join(' ')}${l.eco ? ` (${l.eco})` : ''}, ${l.count} game${l.count === 1 ? '' : 's'}, scored ${l.scorePct ?? '?'}%${l.prepEndsPly ? `, on their own from move ${Math.ceil(l.prepEndsPly / 2)}` : ''}`).join('\n');
  const time = report.timeManagement ? `Clock behaviour: ${report.timeManagement.comfortBlunders} mistakes with over 5 minutes left, ${report.timeManagement.underTwoMinMoments} mistakes under 2 minutes, ${report.timeManagement.fastMoments} failed snap-moves.` : 'No clock data.';
  return `${prepSheetInstructions()}

---

Preparation dossier for the opponent ${subject}, from ${report.games} engine-analysed game${report.games === 1 ? '' : 's'}.

Their errors by type:
${cats || '- none recorded'}

Their errors by phase:
${phases}

Their recurring weaknesses (named from explained moments):
${pats || '- none yet'}

Their repertoire:
${lines || '- unknown'}

${time}

---

Write ${subject}'s preparation sheet now, filling every field. Use only the data above; do not invent openings, lines, or tendencies that are not supported by it.`;
}

// Optional coach narration of the predicted opening-clash lines. The schema
// exposes only prose keyed to line ids already in the prompt: the model never
// picks or evaluates a move (every move, eval, and share is produced by the
// server from real games and the engine).
export const CLASH_NARRATION_SCHEMA = {
  type: 'object',
  properties: {
    headline: { type: 'string', description: 'One short sentence: the single most useful thing to know across these lines' },
    notes: {
      type: 'array',
      description: 'One note per line id given, in any order',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer', description: 'The line id from the prompt' },
          note: { type: 'string', description: 'One short, practical sentence for the student, grounded only in the given facts' },
        },
        required: ['index', 'note'],
      },
    },
  },
  required: ['headline', 'notes'],
};

const CLASH_NARRATION_INSTRUCTIONS = 'v1: a headline plus one grounded, one-sentence note per predicted line; never add or evaluate moves.';

export function clashNarrationVersion() {
  return createHash('sha1').update(CLASH_NARRATION_INSTRUCTIONS + JSON.stringify(CLASH_NARRATION_SCHEMA)).digest('hex').slice(0, 12);
}

/** Narrate the predicted clash lines. Every line is a given fact (moves, why the
 * prediction ends, and an engine eval when present); the model only writes prose. */
export function clashLinePrompt(subjectName, lines) {
  const subject = field(subjectName);
  const rows = lines.map(l => {
    const side = l.color === 'white' ? 'you as White' : 'you as Black';
    const evalTxt = l.endEval != null ? ` Engine evaluation after the suggested move: ${formatEval(l.endEval)} (positive favours White).` : '';
    return `Line ${l.idx} (${side}): ${l.sanLine}. The prediction ends here because ${l.endReason}.${evalTxt}`;
  }).join('\n');
  return `Opponent: ${subject}.
These are predicted opening lines between the student and this opponent, built from real games (the student's own games and the opponent's whole book). Each line is given in full; the "prediction ends" note says why the tree stopped there.

${rows}

For each line id above, write one short, practical note (a single sentence) on what the student should know or aim for in that line, using ONLY the facts given. Do not add moves, do not evaluate positions, and do not invent variations. Then write one short headline: the single most useful thing to take from these lines. Name an opening only if you are confident; otherwise describe the pawn structure or plan.`;
}

export const PATTERN_SYNTH_SCHEMA = {
  type: 'object',
  properties: {
    rule: { type: 'string', description: 'The general principle the player keeps violating, one or two sentences, transferable to new positions' },
    triggers: { type: 'string', description: 'The concrete board or clock cues that should alert the player the pattern is in play, one or two sentences' },
    advice: { type: 'string', description: 'One practical habit or check to apply before moving, one sentence' },
  },
  required: ['rule', 'triggers', 'advice'],
};

/** Synthesize a recurring pattern from its instances into one transferable lesson. */
export function patternSynthesisPrompt(pattern, instances) {
  const list = instances.map((x, i) => `${i + 1}. ${x.label}${x.date ? ', ' + x.date : ''}: played ${x.san} (${x.judgment}), engine preferred ${x.bestSan}. Position: ${x.fen}. Coach note: ${x.explanation} Key question: ${x.key_question}`).join('\n');
  return `The player has repeatedly shown the pattern "${pattern}". The instances, each already explained from engine analysis:

${list}

Synthesize what these instances have in common into one transferable lesson for this player. Use only the instances above: do not invent positions, variations, or evaluations. Return: rule (the principle the player keeps violating), triggers (the cues that should alert them), advice (one habit to apply before moving).`;
}

/** A previous explanation was rated unhelpful: ask for a clearly better one. */
export function reExplainSuffix(prior) {
  return `

A previous explanation for this moment was shown to the student and rated NOT helpful. It was:
"${prior}"

Write a clearly better explanation: more concrete, tied strictly to the given lines, naming the exact threat or resource that was missed. Do not repeat the old wording.`;
}

export function systemPrompt(rating) {
  return `You are a chess coach explaining Stockfish analysis to a FIDE ${rating || 2000} rated player.
You are given a position (FEN), the move that was played, and the engine's top lines with evaluations.
Rules:
- Ground every claim in the engine lines provided. Do not invent variations, do not extend lines beyond what is given, and do not evaluate moves the engine did not list.
- Explain in terms a strong club player uses: threats, piece activity, pawn structure, king safety, plans, typical patterns.
- Be concrete and brief: the explanation is one paragraph of at most 120 words. No praise, no filler, no generic advice.
- Plain punctuation: commas, colons, and parentheses. Never use em dashes.
- Evaluations are from White's point of view; positive favours White.`;
}

/** The whole-game debrief is a different task from a single-moment explanation;
 * give it its own persona so the model is not told to write "120 words" or to
 * "not extend lines beyond those given". */
export function gameSummarySystemPrompt(rating) {
  return `You are a chess coach writing a short debrief of a whole game for a FIDE ${rating || 2000} rated player, from Stockfish's analysis of it.
Rules:
- Ground every claim in the moves and evaluations provided. Do not invent variations or evaluations.
- Speak to the player about their game: how it went, where it turned, and the one habit to take away.
- Be concrete and brief. No filler, no praise for its own sake.
- Plain punctuation: commas, colons, and parentheses. Never use em dashes.
- Evaluations are from White's point of view; positive favours White.`;
}

export function gameSummaryPrompt(game) {
  const s = game.analysis.summary;
  const color = game.playerColor;
  const p = s[color];
  const side = color === 'white' ? 'White' : 'Black';
  const moments = s.moments.map(ply => {
    const m = game.analysis.moves[ply - 1];
    const e = game.explanations?.[ply];
    return `- Move ${m.moveNumber}${m.color === 'white' ? '.' : '...'} ${m.san} (${m.judgment}, ${m.phase}, eval ${formatEval(m.evalBefore)} to ${formatEval(m.evalAfter)}, engine preferred ${m.bestSan})` + (e ? ` : ${e.category}, "${e.pattern}"` : '');
  }).join('\n');
  const allMoves = sanLine(game.analysis.moves);
  return `Game: ${field(game.headers.White)} vs ${field(game.headers.Black)}, ${field(game.headers.Event, 120)} ${field(game.headers.Date, 20)}, result ${field(game.headers.Result, 12)}.
The player being coached had ${side}. Accuracy ${p.accuracy}%, average centipawn loss ${p.acpl}, ${p.inaccuracies} inaccuracies, ${p.mistakes} mistakes, ${p.blunders} blunders.
Phase accuracy: ${['opening', 'middlegame', 'endgame'].map(ph => p.byPhase[ph] ? `${ph} ${p.byPhase[ph].accuracy}%` : `${ph} n/a`).join(', ')}.

Moves: ${allMoves}

Critical moments for ${side} (engine-flagged):
${moments || '- none'}

Write the summary, the one lesson, and the opening note for this player. Base the opening note on the actual moves; if you are not confident of the opening's name, say so rather than guessing.`;
}
