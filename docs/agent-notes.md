# Notes for your agent

When an agent writes the code, reviewing it is a conversation with the agent, not with GitHub.
In `pile review` you can leave **notes for your agent** on any line of a diff, old or new
side, or on the branch as a whole, and hand them over with one command:

```bash
pile notes                 # the current branch's open notes, as instructions
claude "$(pile notes)"     # or hand them straight to an agent
```

## Leaving notes

- **Local branches** (not on GitHub yet): every comment is a note. Hover a line number, click
  **+**, write, and **Save note**. The "Notes for your agent" section on the page takes notes
  about the branch as a whole.
- **Pull requests**: the comment box has a switch between **Review comment** (part of your
  GitHub review) and **Note for agent** (stays on your machine). On your own PRs it starts on
  notes; on someone else's, on review comments.

Notes show inline in the diff and in the "Notes for your agent" section, where you can mark them
done, reopen or delete them, and copy the command that hands them over.

## What the agent gets

Each note comes with where it is, the code the reviewer was looking at (with the line marked),
and the comment. Notes on the old side say so, since they're usually "the previous version was
better":

````
## src/search/api.ts:16 (id `a7a3d6`)

```ts
  15 |   const start = Number(url.searchParams.get("cursor") ?? 0);
> 16 |   const all = index.search(query);
  17 |   const ids = all.slice(start, start + PAGE_SIZE);
```

Validate the cursor: a negative or non-numeric value should return a 400.
````

`pile notes --json` gives the same as structured data.

## Managing notes

| Command | |
|---------|---|
| `pile notes` | Open notes on the current branch |
| `pile notes --branch <name>` / `--all` | Another branch / every branch |
| `pile notes done <id>…` | Mark notes handled (an agent can do this itself) |
| `pile notes reopen <id>` | Open it again |
| `pile notes rm <id>` | Delete it |
| `pile notes clear` | Delete the finished ones |

## Where they live

`.pile/notes.json` in the repository, with a readable copy of the open notes in
`.pile/notes.md` for agents that prefer reading files. pile adds `.pile/` to
`.git/info/exclude`, so the notes never show up in `git status` or get committed, and your
`.gitignore` isn't touched. Notes never leave your machine.
