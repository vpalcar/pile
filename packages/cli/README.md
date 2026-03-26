# Pile

```
       ██████╗ ██╗██╗     ███████╗
       ██╔══██╗██║██║     ██╔════╝
       ██████╔╝██║██║     █████╗
       ██╔═══╝ ██║██║     ██╔══╝
       ██║     ██║███████╗███████╗
       ╚═╝     ╚═╝╚══════╝╚══════╝
```

**The AI-native stacked PR CLI for humans.**

Pile is a command-line tool for managing stacked pull requests on GitHub. It helps you break down large changes into small, reviewable PRs that stack on top of each other.

```
        ┌───┐
        │ 3 │  ← feature-c
        └─┬─┘
        ┌─┴─┐
        │ 2 │  ← feature-b
        └─┬─┘
        ┌─┴─┐
        │ 1 │  ← feature-a
        └─┬─┘
        ──┴──  ← main
```

## Features

- **Stacked branches** - Create branches that build on each other
- **Automatic rebasing** - Keep your stack in sync with `pile sync`
- **GitHub integration** - Create and update PRs with `pile submit`
- **Offline support** - Queue operations when offline, sync when back online
- **AI-friendly** - JSON output for all commands (`--json`)

## Installation

```bash
npm install -g pile-cli
```

Or with other package managers:

```bash
pnpm add -g pile-cli
yarn global add pile-cli
```

### From source

```bash
git clone https://github.com/vpalcar/pile.git
cd pile
pnpm install
pnpm build
pnpm -C packages/cli link --global
```

## Quick Start

```bash
# Initialize pile in your repo
pile init

# Create your first stacked branch
pile create -m "Add user authentication"

# Make changes and create another branch on top
pile create -m "Add login form"

# View your stack
pile log

# Submit PRs for your stack
pile submit --stack

# Switch branches
pile checkout            # Interactive selector
pile checkout main       # Go to trunk
pile checkout my-branch  # Go to specific branch
```

## Commands

### Stack Management

| Command | Alias | Description |
|---------|-------|-------------|
| `pile create -m "message"` | `c` | Create a new stacked branch with a commit |
| `pile log` | `l` | View the branch stack tree |
| `pile checkout [branch]` | `co` | Checkout a branch (interactive if no branch given) |
| `pile delete` | `del` | Delete current branch, close PR, switch to parent |
| `pile modify` | `m` | Amend or squash commits |
| `pile rename` | `rn` | Rename the current branch |
| `pile move` | `mv` | Move branch to a different parent |
| `pile restack` | `rs` | Rebase all branches onto their parents |
| `pile sync` | | Fetch, update trunk, restack, cleanup merged |

### PR Operations

| Command | Alias | Description |
|---------|-------|-------------|
| `pile submit` | `s` | Push and create/update PR |
| `pile submit --stack` | `s -s` | Submit all PRs in the stack |
| `pile add` | `a` | Stage files for commit |
| `pile status` | `st` | View PR status, reviews, CI checks |
| `pile merge` | | Merge the PR (squash by default) |
| `pile close` | | Close PR without merging |
| `pile edit` | | Edit PR title, body, labels, etc. |

### Review Operations

| Command | Description |
|---------|-------------|
| `pile review --approve` | Approve the PR |
| `pile review --request-changes -m "message"` | Request changes |
| `pile review -m "comment"` | Add a comment |
| `pile request user1 user2` | Request review from users |

## Examples

### Creating a Stack

```bash
# Start from main
git checkout main

# Create first feature branch
pile create -m "Add database schema"

# Make more changes, create next branch
pile create -m "Add API endpoints"

# And another
pile create -m "Add frontend components"

# View the stack
pile log
```

Output:
```
  main
  │
  ○ 03-22-add-database-schema
  │
  ○ 03-22-add-api-endpoints
  │
  ● 03-22-add-frontend-components  ← you are here
```

### Submitting PRs

```bash
# Submit just the current branch
pile submit

# Submit the entire stack
pile submit --stack

# Submit as draft
pile submit --draft

# Open PR in browser after creating
pile submit --open
```

### Syncing Your Stack

```bash
# Fetch latest, rebase stack, cleanup merged branches
pile sync
```

### Reviewing PRs

```bash
# Check out a branch and approve its PR
pile co feature-branch
pile review --approve -m "LGTM!"

# Request changes
pile review --request-changes -m "Please add tests"
```

## Configuration

Pile stores its configuration in `.pile/config.json`:

```json
{
  "trunk": "main",
  "remote": "origin",
  "mergeMethod": "squash",
  "autoOpenPR": false
}
```

## JSON Output

All commands support `--json` for machine-readable output:

```bash
pile log --json
pile status --json
pile submit --json
```

This makes Pile ideal for AI-assisted development workflows.

## Requirements

- Node.js 18+
- Git
- GitHub account with authentication (`gh auth login` or `GITHUB_TOKEN`)

## License

MIT
