// Opening repertoire: games grouped by colour and first moves, with score and where prep ends.
import { api, esc } from '../api.js';

export async function repertoireView(root) {
  const { repertoire } = await api.repertoire();
  if (!repertoire.length) {
    root.innerHTML = '<h1>Repertoire</h1><div class="empty">Appears once games are analysed.</div>';
    return;
  }
  const fmtLine = sans => sans.map((s, i) => (i % 2 === 0 ? `${i / 2 + 1}.` : '') + s).join(' ');
  const prepText = l => l.prepEndsPly ? `move ${Math.ceil(l.prepEndsPly / 2)}` : '–';
  const explorer = l => `https://lichess.org/analysis/pgn/${encodeURIComponent(fmtLine(l.line))}`;
  const section = color => {
    const lines = repertoire.filter(l => l.color === color);
    if (!lines.length) return '';
    return `<h2>As ${color} <span class="chip ${color}">${lines.reduce((s, l) => s + l.count, 0)} games</span></h2>
      <table><thead><tr><th>Line</th><th>ECO</th><th class="num">Games</th><th class="num">Score</th><th class="num">Accuracy</th><th class="num">Prep ends</th><th>Games</th></tr></thead>
      <tbody>${lines.map(l => `<tr>
        <td>${esc(fmtLine(l.line))} <a href="${explorer(l)}" target="_blank" rel="noopener" title="Open on the lichess analysis board">↗</a>${l.moveOrders > 1 ? ` <span class="chip" title="Reached by ${l.moveOrders} move orders; the most common one is shown">${l.moveOrders} orders</span>` : ''}</td>
        <td>${esc(l.eco)}</td>
        <td class="num">${l.count}</td>
        <td class="num">${l.scorePct != null ? l.scorePct + '%' : '–'}</td>
        <td class="num">${l.accuracy}%</td>
        <td class="num">${prepText(l)}</td>
        <td>${l.games.slice(0, 5).map(g => `<a href="#/game/${g.id}${g.deviationPly ? '/' + g.deviationPly : ''}" title="${esc(g.label)} ${esc(g.result)}">${esc(g.date || g.result)}</a>`).join(' ')}</td>
      </tr>`).join('')}</tbody></table>`;
  };
  root.innerHTML = `
    <h1>Repertoire</h1>
    <p class="muted">Analysed games grouped by the position after 8 plies, so transpositions merge (the most common move order is shown). "Prep ends" is the first move in the opening where you left the engine's top lines or lost 10+ win-probability points: the earliest such move across the line's games. Game links jump straight to that move; ↗ opens the line on lichess for explorer study.</p>
    ${section('white')}
    ${section('black')}`;
}
