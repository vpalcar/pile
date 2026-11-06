# Changelog

## 1.0.0

### The review app

`pile review` opens a local web app for reviewing (see [docs/review.md](docs/review.md)).

- **Inbox** of every open PR and local branch, grouped into needs review, yours, local and
  others, with a readiness status per row (draft, in review, changes requested, checks failing,
  approved, ready to merge), checks, comments and size. Search, tabs and keyboard navigation.
- **Stacks**, including stacks that branch: each branch gets its own lane, in the inbox and on
  the PR page.
- **PR page** with the stack, description, discussion, checks, reviewers, labels and assignees,
  and a diff with a file tree, split and unified layouts, syntax highlighting, word-level
  changes, expandable context and viewed-file tracking.
- **Reviewing**: comment on any line of the old or new code, reply in discussions, and submit
  reviews (comment, approve, request changes) with inline comments.
- **Editing**: request and remove reviewers, set labels (creating new ones) and assignees, and
  move your own PRs between draft and ready for review.
- **Checks**: re-run one GitHub Actions check or every failed one; running checks update live.
- **Merging** one PR, or a stack up to a PR, with the same rules as `pile merge`.
- Fast: the inbox answers in about 150 ms and PRs open from a warm cache; statuses never flash
  back to "Open" while data refreshes.
- Light and dark themes; preferences saved in `~/.config/pile/review.json`.
- Local only: listens on 127.0.0.1 behind a per-run access token.

### Merging

- `pile merge` merges native GitHub stacks through GitHub's asynchronous merge endpoint.
- The rules for what blocks a merge are shared between `pile merge` and the review app.

### Commands

- Every command works non-interactively: `--json`, `--no-interactive` and `-y` behave the same
  everywhere; missing input exits with code `2` and names the valid choices. `pile commands
  --json` describes the whole CLI.
- PR commands take a target: a branch, a PR number or a PR URL.
- New: `pile up`, `down`, `top`, `bottom`, `track`, `untrack`.
- Fixes to `move`, `rename` and `delete`; failures exit non-zero.

### Performance and robustness

- GitHub reads use REST only, in parallel, with timeouts (GraphQL is used only to switch a PR
  between draft and ready).
- pile state is read with one `git config` call and git runs without a shell; `pile log` is
  about 25x faster on large repos and `pile status` about 3x faster.

### Breaking

- Node.js 20 or later is required.
