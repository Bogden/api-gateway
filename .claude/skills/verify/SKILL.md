---
name: verify
summary: Runtime verification recipe for the API gateway HTTP surface
---

Build the repository, then launch the compiled server with an isolated database/configuration and a non-default port. For provider changes, preload a Node `--import` fixture that intercepts only the provider's upstream URL and delegates all other fetches.

Drive the public HTTP endpoint with curl. Capture the complete JSON or SSE response plus any intercepted outbound request bodies. For usage-accounting changes, also query the request analytics row to verify persistence. Use a temporary Codex home for ChatGPT subscription fixtures.

The root scripts are `npm run build` and `npm test`. If a fresh install lacks the native SQLite binding, run `npm rebuild better-sqlite3` before launching or testing.
