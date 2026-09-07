// Prompt construction for the explanation step. Everything the model sees is engine-grounded.
import { formatEval } from './analyze.js';

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

function clockText(m) {
  if (m.clock == null) return '';
  const mins = Math.floor(m.clock / 60), secs = m.clock % 60;
  return `Clock after the move: ${mins}:${String(secs).padStart(2, '0')} remaining.`;
}

/** Build the user prompt for one critical moment. `knownPatterns` are pattern names already used for this player. */
export function momentPrompt(game, ply, knownPatterns = []) {
  const moves = game.analysis.moves;
  const m = moves[ply - 1];
  const side = m.color === 'white' ? 'White' : 'Black';
  const playerName = game.headers[side] || side;
  const opening = moves.slice(0, 20).map(x => (x.color === 'white' ? `${x.moveNumber}.` : '') + x.san).join(' ');
  const recent = moves.slice(Math.max(0, ply - 9), ply - 1).map(x => (x.color === 'white' ? `${x.moveNumber}.` : '') + x.san).join(' ');
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
Win-probability lost by this move: ${m.loss} points (${m.judgment}). ${clockText(m)}

Explain why ${m.san} is classified as ${m.judgment === 'inaccuracy' ? 'an' : 'a'} ${m.judgment} and what the engine's first choice ${m.bestSan} achieves instead, using only the lines above. Then classify the error.${knownPatterns.length ? `

Pattern names already in this player's library (reuse one verbatim if it fits, so recurring weaknesses aggregate; otherwise coin a new short name):
${knownPatterns.map(p => `- ${p}`).join('\n')}` : ''}`;
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
  const allMoves = game.analysis.moves.map(x => (x.color === 'white' ? `${x.moveNumber}.` : '') + x.san).join(' ');
  return `Game: ${game.headers.White || '?'} vs ${game.headers.Black || '?'}, ${game.headers.Event || ''} ${game.headers.Date || ''}, result ${game.headers.Result || '*'}.
The player being coached had ${side}. Accuracy ${p.accuracy}%, average centipawn loss ${p.acpl}, ${p.inaccuracies} inaccuracies, ${p.mistakes} mistakes, ${p.blunders} blunders.
Phase accuracy: ${['opening', 'middlegame', 'endgame'].map(ph => p.byPhase[ph] ? `${ph} ${p.byPhase[ph].accuracy}%` : `${ph} n/a`).join(', ')}.

Moves: ${allMoves}

Critical moments for ${side} (engine-flagged):
${moments || '- none'}

Write the summary, the one lesson, and the opening note for this player. Base the opening note on the actual moves; if you are not confident of the opening's name, say so rather than guessing.`;
}
