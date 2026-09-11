// Report and Repertoire on one page, as collapsible accordions. The two views
// are rendered unchanged into the accordion bodies; the weakness report is open
// by default (its charts need a visible width), the repertoire renders the first
// time it is expanded.
import { reportView } from './report.js';
import { repertoireView } from './repertoire.js';

export async function reviewView(root) {
  root.innerHTML = `
    <h1>Report</h1>
    <details class="acc rr" open><summary><span class="acc-title">Weakness report</span></summary><div class="acc-body" id="rr-report"></div></details>
    <details class="acc rr"><summary><span class="acc-title">Repertoire</span></summary><div class="acc-body" id="rr-repertoire"></div></details>`;
  await reportView(root.querySelector('#rr-report'));
  const repAcc = root.querySelectorAll('.acc.rr')[1];
  let rendered = false;
  repAcc.addEventListener('toggle', () => {
    if (repAcc.open && !rendered) { rendered = true; repertoireView(root.querySelector('#rr-repertoire')); }
  });
}
