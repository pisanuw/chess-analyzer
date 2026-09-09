// The whole Express app as one Netlify function. Game data files are bundled
// into the deploy (read-only mirror); drill state goes to Supabase via env.
import serverless from 'serverless-http';
import { app } from '../../server/index.js';

const wrapped = serverless(app);

export const handler = (event, context) => {
  event.path = event.path.replace(/^\/\.netlify\/functions\/api/, '') || '/';
  return wrapped(event, context);
};
