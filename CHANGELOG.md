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
- **Title, description and media**: edit a PR's title and description in place, and paste or
  drop images and videos into the description and discussion; the GitHub CLI (2.99+) uploads them
  so they show inline on GitHub, videos with its player.
- **Checks**: re-run one GitHub Actions check or every failed one; running checks update live.
- **Merging** one PR, or a stack up to a PR, with the same rules as `pile merge`.
- Fast: the inbox answers in about 150 ms and PRs open from a warm cache; statuses never flash
  back to "Open" while data refreshes.
- Light and dark themes; preferences saved in `~/.config/pile/review.json`.
- Local only: listens on 127.0.0.1 behind a per-run access token.

### Notes for your agent

Review an agent's work like a colleague's (see [docs/agent-notes.md](docs/agent-notes.md)).

- Leave **notes for your agent** on any line of a diff (old or new code) or on a whole branch.
  On local branches every comment is a note; on PRs the comment box switches between a GitHub
  review comment and a note.
- **`pile notes`** hands them over as instructions with the code around each line
  (`claude "$(pile notes)"`); `--json` for structured output.
- The agent answers: `pile notes done <id> -m "what changed"` resolves a note with a summary,
  `pile notes reply` asks or pushes back. Replies show up live in the review app, and replying
  to a resolved note reopens it.
- Notes stay on your machine in `.pile/`, kept out of `git status`.

### GitHub stacks

- `pile submit` registers your stack as a GitHub stack (bottom to top), adds new PRs on top,
  and rebuilds it when branches moved. A diverging branch stays outside, with a note. PRs
  opened outside pile (`gh`, the website) are found by branch; when a stack can't be registered,
  submit says which branch is in the way.
- The review app shows GitHub's stack when a PR is in one, and labels stacks it inferred from
  branches as "Linked by branches".

### Merging

- `pile merge` merges native GitHub stacks through GitHub's asynchronous merge endpoint.
- The rules for what blocks a merge are shared between `pile merge` and the review app.
- A stack merge lands every PR on the trunk, in order, one commit each: PRs pile didn't open are
  retargeted too, and a PR is never merged into the branch below it.

### Commands

- Every command works non-interactively: `--json`, `--no-interactive` and `-y` behave the same
  everywhere; missing input exits with code `2` and names the valid choices. `pile commands
  --json` describes the whole CLI.
- PR commands take a target: a branch, a PR number or a PR URL.
- New: `pile up`, `down`, `top`, `bottom`, `track`, `untrack`.
- Fixes to `move`, `rename` and `delete`; failures exit non-zero.
- `create` and `modify` show what the commit hooks print and take `--no-verify`. When a hook
  fails they name the failed step, show its last lines (the full log is saved, or printed with
  `--verbose`) and say what state it left: no branch created, changes still staged.
- Branch names from long messages are cut at a whole word.
- `submit -b <text>` (or `-b -` for stdin) sets the PR body; new PRs otherwise start from the
  repository's pull request template.
- `status --body` and `--comments` show a PR's description and comments, also in `--json`.
- `pile log` draws stacks that branch like `git log --graph`, joining each branch where it
  forks (it used to draw every join at the trunk).

### Performance and robustness

- GitHub reads use REST only, in parallel, with timeouts (GraphQL is used only to switch a PR
  between draft and ready).
- pile state is read with one `git config` call and git runs without a shell; `pile log` is
  about 25x faster on large repos and `pile status` about 3x faster.

### Breaking

- Node.js 20 or later is required.
