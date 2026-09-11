// The Report page: the weakness report renders its own collapsible sections
// (report.js) at the top level, followed by the Repertoire as one more
// accordion that renders the first time it is expanded.
import { reportView } from './report.js';
import { repertoireView } from './repertoire.js';

export async function reviewView(root) {
  root.innerHTML = `
    <h1>Report</h1>
    <div id="rr-report"></div>
    <details class="acc rr"><summary><span class="acc-title">Repertoire</span></summary><div class="acc-body" id="rr-repertoire"></div></details>`;
  await reportView(root.querySelector('#rr-report'));
  const repAcc = root.querySelector('.acc.rr');
  let rendered = false;
  repAcc.addEventListener('toggle', () => {
    if (repAcc.open && !rendered) { rendered = true; repertoireView(root.querySelector('#rr-repertoire')); }
  });
}
