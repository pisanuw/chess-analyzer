// Prompt construction for the explanation step. Everything the model sees is engine-grounded.
import { formatEval, spentPerMove } from '../public/shared.js';

const sanLine = ms => ms.map(x => (x.color === 'white' ? `${x.moveNumber}.` : '') + x.san).join(' ');

const conceptsBlock = concepts => concepts?.length ? `

Concept names already used for this player (reuse one verbatim if it fits, so study topics aggregate; otherwise coin a new short phrase):
${concepts.map(c => `- ${c}`).join('\n')}` : '';

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

export const PREP_SHEET_SCHEMA = {
  type: 'object',
  properties: {
    overview: { type: 'string', description: 'Two to four sentences describing this opponent\'s play and main weaknesses' },
    exploit_plan: { type: 'string', description: 'The concrete game plan to exploit them: which phases and structures to steer toward and why, one paragraph' },
    openings_advice: { type: 'string', description: 'What to play against their repertoire, referencing their actual lines and where their preparation ends' },
    watch_fors: { type: 'string', description: 'Three to five specific cues to watch for during the game, as one compact list in prose' },
  },
  required: ['overview', 'exploit_plan', 'openings_advice', 'watch_fors'],
};

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

/** Scout variant of momentPrompt: same engine grounding, exploitation framing. */
export function scoutMomentPrompt(game, ply, knownPatterns = [], knownConcepts = []) {
  const moves = game.analysis.moves;
  const m = moves[ply - 1];
  const side = m.color === 'white' ? 'White' : 'Black';
  const subject = game.subject || game.headers[side] || 'the opponent';
  const opening = sanLine(moves.slice(0, 20));
  const recent = sanLine(moves.slice(Math.max(0, ply - 9), ply - 1));
  const lines = m.lines.map(l => `  ${l.multipv}. ${l.san.join(' ')} (eval ${formatEval(l.cp)})`).join('\n');
  const next = moves[ply]; // the reply position: how the punishment starts
  const punishLines = next?.lines?.length ? `\nEngine lines AFTER the mistake (${next.color === 'white' ? 'White' : 'Black'} to move, the punishment):\n${next.lines.map(l => `  ${l.multipv}. ${l.san.join(' ')} (eval ${formatEval(l.cp)})`).join('\n')}\n` : '';
  return `You are scouting ${subject}, who played ${side} in this game: ${game.headers.White || '?'} vs ${game.headers.Black || '?'}, ${game.headers.Event || 'unknown event'} ${game.headers.Date || ''}, result ${game.headers.Result || '*'}.

Opening moves: ${opening}
Recent moves before the mistake: ${recent || '(start of game)'}

Position before their move (FEN): ${m.fenBefore}
Phase: ${m.phase}. Move ${m.moveNumber}, ${side} to move. Evaluation: ${formatEval(m.evalBefore)}.

Engine top lines from this position (${side} to move):
${lines}

${subject} played ${m.san}. Evaluation after it: ${formatEval(m.evalAfter)}. Win-probability lost: ${m.loss} points (${m.judgment}). ${clockText(m, game)}
${punishLines}
Explain what ${m.san} gets wrong and, concretely, how the student punishes it using the lines above. Then classify the error and give the cue that signals this weakness is in play.${knownPatterns.length ? `

Weakness names already recorded for ${subject} (reuse one verbatim if it fits, so their recurring weaknesses aggregate; otherwise coin a new short name):
${knownPatterns.map(p => `- ${p}`).join('\n')}` : ''}${conceptsBlock(knownConcepts)}`;
}

/** Scout variant of the game summary: how the subject plays and how to face them. */
export function scoutGameSummaryPrompt(game) {
  const s = game.analysis.summary;
  const side = game.playerColor === 'white' ? 'White' : 'Black';
  const subject = game.subject || 'the opponent';
  const p = s[game.playerColor];
  const moments = s.moments.map(ply => {
    const m = game.analysis.moves[ply - 1];
    const e = game.explanations?.[ply];
    return `- Move ${m.moveNumber}${m.color === 'white' ? '.' : '...'} ${m.san} (${m.judgment}, ${m.phase}, eval ${formatEval(m.evalBefore)} to ${formatEval(m.evalAfter)}, engine preferred ${m.bestSan})` + (e ? ` : ${e.category}, "${e.pattern}"` : '');
  }).join('\n');
  const allMoves = sanLine(game.analysis.moves);
  return `You are scouting ${subject}, who played ${side} in this game: ${game.headers.White || '?'} vs ${game.headers.Black || '?'}, ${game.headers.Event || ''} ${game.headers.Date || ''}, result ${game.headers.Result || '*'}.
Their accuracy ${p.accuracy}%, average centipawn loss ${p.acpl}, ${p.inaccuracies} inaccuracies, ${p.mistakes} mistakes, ${p.blunders} blunders.

Moves: ${allMoves}

${subject}'s mistakes (engine-flagged):
${moments || '- none'}

Write: summary (how ${subject} handled this game and where they went wrong), lesson (the one thing the student should exploit when facing them), opening_note (what ${subject} played and whether leaving it early would help; name the opening only if confident).`;
}

/** One-page preparation sheet for a subject, from their aggregated dossier. */
export function prepSheetPrompt(subject, report, repertoire) {
  const cats = Object.entries(report.byCategory).filter(([k, v]) => k !== 'unexplained' && v.count).map(([k, v]) => `- ${k}: ${v.count} moments (weight ${v.weight})`).join('\n');
  const phases = ['opening', 'middlegame', 'endgame'].map(ph => { const p = report.byPhase[ph]; return `- ${ph}: accuracy ${p.accuracy ?? 'n/a'}%, ${p.momentsPer100 ?? 'n/a'} moments per 100 moves`; }).join('\n');
  const pats = report.patterns.slice(0, 10).map(p => `- "${p.pattern}" (${p.count}x)`).join('\n');
  const lines = repertoire.map(l => `- as ${l.color}: ${l.line.map((s, i) => (i % 2 === 0 ? `${i / 2 + 1}.` : '') + s).join(' ')}${l.eco ? ` (${l.eco})` : ''}, ${l.count} game${l.count === 1 ? '' : 's'}, scored ${l.scorePct ?? '?'}%${l.prepEndsPly ? `, on their own from move ${Math.ceil(l.prepEndsPly / 2)}` : ''}`).join('\n');
  const time = report.timeManagement ? `Clock behaviour: ${report.timeManagement.comfortBlunders} mistakes with over 5 minutes left, ${report.timeManagement.underTwoMinMoments} mistakes under 2 minutes, ${report.timeManagement.fastMoments} failed snap-moves.` : 'No clock data.';
  return `Preparation dossier for the opponent ${subject}, from ${report.games} engine-analysed game${report.games === 1 ? '' : 's'}.

Their errors by type:
${cats || '- none recorded'}

Their errors by phase:
${phases}

Their recurring weaknesses (named from explained moments):
${pats || '- none yet'}

Their repertoire:
${lines || '- unknown'}

${time}

Write the preparation sheet for a student about to face ${subject}: overview, exploit_plan, openings_advice, watch_fors. Use only the data above; do not invent openings, lines, or tendencies that are not supported by it.`;
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

function clockText(m, game) {
  if (m.clock == null) return '';
  const mins = Math.floor(m.clock / 60), secs = m.clock % 60;
  const base = `Clock after the move: ${mins}:${String(secs).padStart(2, '0')} remaining.`;
  // Deterministic time-spent, so time_pressure is not guessed from one number.
  const spent = game?.analysis?.moves ? spentPerMove(game.analysis.moves, game.headers?.TimeControl)[m.ply - 1] : null;
  if (spent == null) return base;
  return `${base} Time spent on this move: about ${spent} seconds.`;
}

/** Build the user prompt for one critical moment. `knownPatterns` are pattern names already used for this player. */
export function momentPrompt(game, ply, knownPatterns = [], knownConcepts = []) {
  const moves = game.analysis.moves;
  const m = moves[ply - 1];
  const side = m.color === 'white' ? 'White' : 'Black';
  const playerName = game.headers[side] || side;
  const opening = sanLine(moves.slice(0, 20));
  const recent = sanLine(moves.slice(Math.max(0, ply - 9), ply - 1));
  const lines = m.lines.map(l => `  ${l.multipv}. ${l.san.join(' ')} (eval ${formatEval(l.cp)})`).join('\n');
  const playedRank = m.playedRank ? `This was the engine's line number ${m.playedRank}.` : 'This move is not among the engine\'s top lines.';
  const nextMove = moves[ply]; // opponent's reply
  return `Game: ${game.headers.White || '?'} vs ${game.headers.Black || '?'}, ${game.headers.Event || 'unknown event'} ${game.headers.Date || ''}, result ${game.headers.Result || '*'}.
The player being coached is ${playerName} (${side}), rated about ${game.playerRating || 2000}.

Opening moves: ${opening}
Recent moves before the critical moment: ${recent || '(start of game)'}

Position before the move (FEN): ${m.fenBefore}
Phase: ${m.phase}. Move ${m.moveNumber}, ${side} to move. Engine evaluation before the move: ${formatEval(m.evalBefore)}.

Engine top lines from this position (${side} to move):
${lines}

Move played by ${side}: ${m.san}. Evaluation after it: ${formatEval(m.evalAfter)}. ${playedRank}
${nextMove ? `The opponent replied ${nextMove.san}.` : ''}
Win-probability lost by this move: ${m.loss} points (${m.judgment}). ${clockText(m, game)}

Explain why ${m.san} is classified as ${m.judgment === 'inaccuracy' ? 'an' : 'a'} ${m.judgment} and what the engine's first choice ${m.bestSan} achieves instead, using only the lines above. Then classify the error.${knownPatterns.length ? `

Pattern names already in this player's library (reuse one verbatim if it fits, so recurring weaknesses aggregate; otherwise coin a new short name):
${knownPatterns.map(p => `- ${p}`).join('\n')}` : ''}${conceptsBlock(knownConcepts)}`;
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
  return `Game: ${game.headers.White || '?'} vs ${game.headers.Black || '?'}, ${game.headers.Event || ''} ${game.headers.Date || ''}, result ${game.headers.Result || '*'}.
The player being coached had ${side}. Accuracy ${p.accuracy}%, average centipawn loss ${p.acpl}, ${p.inaccuracies} inaccuracies, ${p.mistakes} mistakes, ${p.blunders} blunders.
Phase accuracy: ${['opening', 'middlegame', 'endgame'].map(ph => p.byPhase[ph] ? `${ph} ${p.byPhase[ph].accuracy}%` : `${ph} n/a`).join(', ')}.

Moves: ${allMoves}

Critical moments for ${side} (engine-flagged):
${moments || '- none'}

Write the summary, the one lesson, and the opening note for this player. Base the opening note on the actual moves; if you are not confident of the opening's name, say so rather than guessing.`;
}
