// Human labels for the fixed enums, shared by every view (so views never import
// each other for a lookup table).

export const CATEGORY_LABEL = {
  'tactics-allowed': 'Overlooked opponent tactic',
  'tactics-missed': 'Missed own tactic',
  'calculation': 'Miscalculated a line',
  'positional': 'Positional / plan',
  'opening': 'Opening knowledge',
  'endgame-technique': 'Endgame technique',
  'conversion': 'Converting a win',
  'defence': 'Defensive resource',
  'unexplained': 'Not yet explained',
};

export const KIND_LABEL = { 'find-best': 'Find the best move', threat: 'See the threat', punish: 'Punish (scout)', opening: 'Opening prep', line: 'Prepared line' };
