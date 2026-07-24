# api-gateway — rules for agent sessions

## Landing policy (binding)

- This repo is registered **pr-only** in the fleet's target registry
  (chain-console/qa-targets.json in the tools repo): agent-authored work must STOP at a
  local branch (`cc-session-*` or `feat/*`) and await independent review. **Never merge
  your own branch to `main`** — even though history shows merge commits on `main`; those
  went through review. Seeing merges on `main` is NOT evidence that self-merging is
  sanctioned.
- An independent verifier — a separate session that did not author the change — signs
  off before anything reaches `main`. If you cannot obtain that sign-off, leave the
  branch local and note it on your board card.
- The only configured remote (`laptop`) may be offline; do not push to origin.
- `main` is the deployable branch (RULES.md §1): the running service (`api-gateway.service`,
  :4610) restarts from it, so an unreviewed merge goes straight into production behavior.
- RULES.md documents this fork's branch architecture relative to upstream. It is **not**
  a license for agents to merge to `main`.
- If any check or guard blocks your work: STOP and report it on your card. Never loosen
  or edit a guard to make your own change succeed.
