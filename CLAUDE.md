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
- `main` is the deployable branch (RULES.md §1): the running service (`api-gateway.service`,
  :4610) restarts from it, so an unreviewed merge goes straight into production behavior.

## Repository identity — read before ANY push or PR (binding)

**This checkout has three remotes and only one of them is ours.** Never let a tool pick
between them for you.

| Remote | Points at | Ours? |
| --- | --- | --- |
| `origin` | `Bogden/api-gateway` | **yes — the only push target** |
| `upstream` | `MLuqmanBR/api-gateway` | no — a stranger's public fork |
| `laptop` | an ssh path to the old laptop | ours, often offline |

- **Always name the base repository when opening a pull request:**
  `gh pr create --repo Bogden/api-gateway …`. `gh` does not ask which repository a PR
  should target — it picks one from the remotes, and its preference order puts a remote
  named `upstream` AHEAD of `origin`. The default base here is therefore
  `MLuqmanBR/api-gateway`, a third party's PUBLIC repository.
- This is not hypothetical. It has fired twice: `MLuqmanBR/api-gateway#2` (still open) and
  `#3` (closed within seconds, but it carried 40 files and ~3,700 added lines of this
  fork's private work — `codex-auth.ts`, the ChatGPT provider, this very CLAUDE.md). A
  closed pull request's diff stays publicly readable on GitHub forever, so the disclosure
  cannot be taken back.
- The base is now pinned in this checkout (`gh repo set-default Bogden/api-gateway`, which
  writes `remote.origin.gh-resolved` into `.git/config`), and a PreToolUse guard in the
  fleet harness blocks an unpinned, unqualified `gh pr create`. **Neither survives a fresh
  clone** — `.git/config` is not tracked. In a new clone, re-run `gh repo set-default
  Bogden/api-gateway` before doing anything else.
- Same rule for pushes: push to `origin` (or an explicit remote name). Never `git push
  upstream`, and never a bare `git push` on a branch whose upstream tracking you have not
  checked with `git branch -vv`.
- **This fork is PUBLIC** — GitHub does not allow a fork of a public repository to be
  private. Everything pushed to `origin` is world-readable. Treat every branch here as
  published: no credentials, no tokens, no private data in committed files (`.env` is
  gitignored and must stay that way).
- RULES.md documents this fork's branch architecture relative to upstream. It is **not**
  a license for agents to merge to `main`.
- If any check or guard blocks your work: STOP and report it on your card. Never loosen
  or edit a guard to make your own change succeed.
