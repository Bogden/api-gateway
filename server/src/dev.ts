// Dev entrypoint. The deployed service reads HOST/PORT from .env, and a manual
// `npm run dev` in the same checkout used to inherit them — two processes then
// fight over one address and the deployed one crash-loops. So dev defaults to
// its own port and never to whatever .env deploys on. dotenv does not override
// variables that are already set, so this wins over .env.
// An explicit `PORT=… npm run dev` still wins over this default.
process.env.PORT ??= '4611';

await import('./index.js');

export {};
