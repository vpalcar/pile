#!/usr/bin/env node
import { Command } from "commander";
import { render } from "ink";
import React from "react";

import { InitCommand } from "../commands/init.js";
import { CreateCommand } from "../commands/create.js";
import { LogCommand } from "../commands/log.js";

import { SubmitCommand } from "../commands/submit.js";
import { SyncCommand } from "../commands/sync.js";
import { CheckoutCommand } from "../commands/checkout.js";
import { BranchesCommand } from "../commands/branches.js";
import { ModifyCommand } from "../commands/modify.js";
import { StatusCommand } from "../commands/status.js";
import { MergeCommand } from "../commands/merge.js";
import { RestackCommand } from "../commands/restack.js";
import { AddCommand } from "../commands/add.js";
import { MoveCommand } from "../commands/move.js";
import { RenameCommand } from "../commands/rename.js";
import { CloseCommand } from "../commands/close.js";
import { DeleteCommand } from "../commands/delete.js";
import { EditCommand } from "../commands/edit.js";
import { RequestCommand } from "../commands/request.js";
import { ReviewCommand } from "../commands/review.js";
import { DiffCommand } from "../commands/diff.js";
import { ReviewWebCommand } from "../commands/review-web.js";
import { NavCommand } from "../commands/nav.js";
import { TrackCommand, UntrackCommand } from "../commands/track.js";
import { getSecretPileMessage, getPileWisdom } from "../utils/fun.js";
import { resolveOptions } from "../utils/output.js";
import { describeCommands } from "../utils/schema.js";

const program = new Command();

program.name("pile").description("AI-native stacked PR CLI").version("1.0.0");

program
  .option("--json", "Output in JSON format for AI agents", false)
  .option("--no-interactive", "Never prompt; exit with NEEDS_INPUT (code 2) instead")
  .option("-y, --yes", "Confirm destructive actions without prompting");

// init command
program
  .command("init")
  .description("Initialize pile in the current repository")
  .option(
    "-t, --trunk <branch>",
    "Trunk branch name (default: auto-detect main/master)",
  )
  .option("--open-pr", "Automatically open PR links in browser after submit")
  .option("--merge-method <method>", "Default merge method: squash, merge or rebase")
  .option("--remote <name>", "Git remote to push to (default: origin)")
  .action((opts) => {
    const globalOpts = program.opts();
    render(
      React.createElement(InitCommand, {
        trunk: opts.trunk,
        openPr: opts.openPr,
        mergeMethod: opts.mergeMethod,
        remote: opts.remote,
        options: resolveOptions(globalOpts),
      }),
    );
  });

// add command
program
  .command("add [files...]")
  .alias("a")
  .description("Stage files for commit")
  .option("-a, --all", "Stage all changes (new, modified, deleted)")
  .option("-u, --update", "Stage modified and deleted files only")
  .option("-p, --patch", "Interactively select hunks to stage")
  .action((files, opts) => {
    const globalOpts = program.opts();
    render(
      React.createElement(AddCommand, {
        files: files || [],
        all: opts.all,
        update: opts.update,
        patch: opts.patch,
        options: resolveOptions(globalOpts),
      }),
    );
  });

// create command
program
  .command("create [name]")
  .alias("c")
  .description("Create a new stacked branch")
  .requiredOption("-m, --message <message>", "Commit message (required)")
  .option("-a, --all", "Stage all changes before creating branch")
  .option("-u, --update", "Stage all tracked file changes (git add -u)")
  .option(
    "-i, --insert",
    "Insert branch between current branch and its children",
  )
  .action((name, opts) => {
    const globalOpts = program.opts();
    render(
      React.createElement(CreateCommand, {
        name,
        message: opts.message,
        all: opts.all,
        update: opts.update,
        insert: opts.insert,
        options: resolveOptions(globalOpts),
      }),
    );
  });

// modify command
program
  .command("modify")
  .alias("m")
  .description("Squash all commits and stage changes into single commit")
  .option("-a, --all", "Stage all changes before squashing")
  .option("-u, --update", "Stage all tracked file changes (git add -u)")
  .option("-m, --message <message>", "New commit message (optional)")
  .option("--amend", "Only amend last commit instead of squashing all")
  .action((opts) => {
    const globalOpts = program.opts();
    render(
      React.createElement(ModifyCommand, {
        all: opts.all,
        update: opts.update,
        message: opts.message,
        squash: !opts.amend, // Squash by default, --amend disables it
        options: resolveOptions(globalOpts),
      }),
    );
  });

// log command
program
  .command("log")
  .alias("l")
  .description("Display the current stack")
  .action(() => {
    const globalOpts = program.opts();
    render(
      React.createElement(LogCommand, {
        options: resolveOptions(globalOpts),
      }),
    );
  });

// submit command
program
  .command("submit")
  .alias("s")
  .description("Push branch and create/update pull request")
  .option(
    "-s, --stack",
    "Submit entire stack (all branches from trunk to current)",
  )
  .option("-d, --draft", "Create PR as draft")
  .option("-t, --title <title>", "PR title (default: derived from branch name)")
  .option("-r, --reviewers <reviewers...>", "Request reviewers")
  .option("-o, --open", "Open PR in browser after creating")
  .action((opts) => {
    const globalOpts = program.opts();
    render(
      React.createElement(SubmitCommand, {
        stack: opts.stack,
        draft: opts.draft,
        title: opts.title,
        reviewers: opts.reviewers,
        open: opts.open,
        options: resolveOptions(globalOpts),
      }),
    );
  });

// sync command
program
  .command("sync")
  .description("Fetch from remote, update trunk, and restack all branches")
  .action(() => {
    const globalOpts = program.opts();
    render(
      React.createElement(SyncCommand, {
        options: resolveOptions(globalOpts),
      }),
    );
  });

// co command (checkout)
program
  .command("checkout [branch]")
  .alias("co")
  .description("Checkout a branch (interactive if no branch specified)")
  .action((branch) => {
    const globalOpts = program.opts();
    render(
      React.createElement(CheckoutCommand, {
        branch,
        options: resolveOptions(globalOpts),
      }),
    );
  });

// branches command
program
  .command("branches")
  .alias("br")
  .description(
    "View and manage all branches - track/untrack branches for stacking",
  )
  .action(() => {
    const globalOpts = program.opts();
    render(
      React.createElement(BranchesCommand, {
        options: resolveOptions(globalOpts),
      }),
    );
  });

// status command
program
  .command("status [target]")
  .alias("st")
  .description("Show PR status (target: branch, PR number or URL; default: current branch)")
  .action((target) => {
    const globalOpts = program.opts();
    render(
      React.createElement(StatusCommand, {
        target,
        options: resolveOptions(globalOpts),
      }),
    );
  });

// diff command
program
  .command("diff [target]")
  .alias("d")
  .description("Show changes compared to the parent branch (target: branch; default: current)")
  .action((target) => {
    const globalOpts = program.opts();
    render(
      React.createElement(DiffCommand, {
        target,
        options: resolveOptions(globalOpts),
      }),
    );
  });

// merge command
program
  .command("merge [target]")
  .description("Merge a PR (target: branch, PR number or URL; default: current branch)")
  .option("-f, --force", "Merge even if checks are failing or pending, or changes are requested")
  .action((target, opts) => {
    const globalOpts = program.opts();
    render(
      React.createElement(MergeCommand, {
        target,
        force: opts.force,
        options: resolveOptions(globalOpts),
      }),
    );
  });

// restack command
program
  .command("restack")
  .alias("rs")
  .description("Rebase all branches onto their parents")
  .option("-c, --continue", "Continue restack after resolving conflicts")
  .option("-a, --abort", "Abort restack in progress")
  .action((opts) => {
    const globalOpts = program.opts();
    render(
      React.createElement(RestackCommand, {
        continue: opts.continue,
        abort: opts.abort,
        options: resolveOptions(globalOpts),
      }),
    );
  });

// move command
program
  .command("move")
  .alias("mv")
  .description("Move current branch onto a different parent")
  .option("-o, --onto <branch>", "Target parent branch")
  .action((opts) => {
    const globalOpts = program.opts();
    render(
      React.createElement(MoveCommand, {
        onto: opts.onto,
        options: resolveOptions(globalOpts),
      }),
    );
  });

// rename command
program
  .command("rename <new-name>")
  .alias("rn")
  .description("Rename the current branch")
  .action((newName) => {
    const globalOpts = program.opts();
    render(
      React.createElement(RenameCommand, {
        newName,
        options: resolveOptions(globalOpts),
      }),
    );
  });

// close command
program
  .command("close [target]")
  .description("Close a PR without merging (target: branch, PR number or URL; default: current)")
  .option("--reopen", "Reopen a closed PR")
  .action((target, opts) => {
    const globalOpts = program.opts();
    render(
      React.createElement(CloseCommand, {
        target,
        reopen: opts.reopen,
        options: resolveOptions(globalOpts),
      }),
    );
  });

// delete command
program
  .command("delete [branch]")
  .alias("del")
  .description("Delete a branch (default: current), close its PR, and reparent its children")
  .option("-f, --force", "Force delete even if branch has children (reparents them)")
  .action((branch, opts) => {
    const globalOpts = program.opts();
    render(
      React.createElement(DeleteCommand, {
        branch,
        force: opts.force,
        options: resolveOptions(globalOpts),
      }),
    );
  });

// edit command
program
  .command("edit [target]")
  .description("Edit PR metadata (target: branch, PR number or URL; default: current branch)")
  .option("-t, --title <title>", "Update PR title")
  .option("-b, --body [body]", "Update PR body (use '-' for stdin, omit value for editor)")
  .option("--draft", "Convert PR to draft")
  .option("--ready", "Mark PR as ready for review")
  .option("--labels <labels>", "Set labels (comma-separated, replaces existing)")
  .option("--add-labels <labels>", "Add labels (comma-separated, keeps existing)")
  .option("--assignees <assignees>", "Set assignees (comma-separated)")
  .option("--milestone <milestone>", "Set milestone (number or title)")
  .action(async (target, opts) => {
    const globalOpts = program.opts();

    // Handle stdin for body
    let body = opts.body;
    if (body === "-") {
      // Read from stdin
      let data = "";
      process.stdin.setEncoding("utf8");
      for await (const chunk of process.stdin) {
        data += chunk;
      }
      body = data;
    }

    render(
      React.createElement(EditCommand, {
        target,
        title: opts.title,
        body: body,
        draft: opts.draft,
        ready: opts.ready,
        labels: opts.labels,
        addLabels: opts.addLabels,
        assignees: opts.assignees,
        milestone: opts.milestone,
        options: resolveOptions(globalOpts),
      }),
    );
  });

// request command
program
  .command("request [reviewers...]")
  .description("Request review on a PR (default: the current branch's PR)")
  .option("-t, --team <teams...>", "Request review from teams")
  .option("--pr <target>", "PR to request review on: branch, PR number or URL (default: current branch)")
  .action((reviewers, opts) => {
    const globalOpts = program.opts();
    render(
      React.createElement(RequestCommand, {
        target: opts.pr,
        reviewers: reviewers || [],
        teams: opts.team,
        options: resolveOptions(globalOpts),
      }),
    );
  });

// review command
program
  .command("review [target]")
  .description("Open the review app for open pull requests and local branches; with --approve, --request-changes or -m, review the current branch's PR")
  .option("--approve", "Approve the PR")
  .option("--request-changes", "Request changes on the PR")
  .option("-m, --message <message>", "Review comment/message")
  .option("--port <port>", "Port for the review app (default: the same port for each repo, or any free one)")
  .option("--no-open", "Don't open the browser")
  .action((target, opts) => {
    const globalOpts = program.opts();
    const options = resolveOptions(globalOpts);
    if (opts.approve || opts.requestChanges || opts.message) {
      render(
        React.createElement(ReviewCommand, {
          approve: opts.approve,
          requestChanges: opts.requestChanges,
          message: opts.message,
          options,
        }),
      );
      return;
    }
    render(
      React.createElement(ReviewWebCommand, {
        target,
        port: opts.port ? Number(opts.port) : undefined,
        open: opts.open !== false,
        options,
      }),
    );
  });

// navigation commands
for (const [direction, alias, description] of [
  ["up", "u", "Check out the child branch (steps up the stack)"],
  ["down", "dn", "Check out the parent branch (steps down the stack)"],
  ["top", "t", "Check out the top of the current stack"],
  ["bottom", "b", "Check out the bottom of the current stack"],
] as const) {
  const command = program.command(direction).alias(alias).description(description);
  if (direction === "up" || direction === "down") {
    command.argument("[steps]", "Number of levels to move", "1");
  }
  if (direction === "up" || direction === "top") {
    command.option("--to <branch>", "Child to follow when a branch has several children");
  }
  command.action((...args: unknown[]) => {
    const hasSteps = direction === "up" || direction === "down";
    const steps = hasSteps ? parseInt(String(args[0]), 10) : 1;
    const opts = (hasSteps ? args[1] : args[0]) as { to?: string };
    const globalOpts = program.opts();
    render(
      React.createElement(NavCommand, {
        direction,
        steps: Number.isFinite(steps) && steps > 0 ? steps : 1,
        to: opts?.to,
        options: resolveOptions(globalOpts),
      }),
    );
  });
}

// track command
program
  .command("track [branch]")
  .description("Start tracking a branch in pile (default: current branch)")
  .option("-p, --parent <branch>", "Parent branch (default: detected from history)")
  .action((branch, opts) => {
    const globalOpts = program.opts();
    render(
      React.createElement(TrackCommand, {
        branch,
        parent: opts.parent,
        options: resolveOptions(globalOpts),
      }),
    );
  });

// untrack command
program
  .command("untrack [branch]")
  .description("Stop tracking a branch (keeps the git branch; children move to its parent)")
  .action((branch) => {
    const globalOpts = program.opts();
    render(
      React.createElement(UntrackCommand, {
        branch,
        options: resolveOptions(globalOpts),
      }),
    );
  });

// commands: machine-readable description of the CLI
program
  .command("commands")
  .description("List every command with its arguments and options (use --json for a schema)")
  .action(() => {
    const commands = describeCommands(program);
    if (program.opts().json) {
      const globalOptions = program.options.map((o) => ({ flags: o.flags, description: o.description }));
      const exitCodes = { 0: "success", 1: "error", 2: "needs input (rerun with the named argument or flag)" };
      console.log(JSON.stringify({ success: true, data: { globalOptions, exitCodes, commands } }, null, 2));
      return;
    }
    for (const command of commands) {
      const args = command.arguments.map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`)).join(" ");
      console.log(`  ${`${command.name} ${args}`.trim().padEnd(28)} ${command.description}`);
    }
  });

// Easter egg: pile wisdom
program
  .command("wisdom", { hidden: true })
  .description("Get some pile wisdom")
  .action(() => {
    console.log(getSecretPileMessage());
  });

// Easter egg: fortune cookie style wisdom
program
  .command("fortune", { hidden: true })
  .description("Your pile fortune")
  .action(() => {
    console.log(`\n  🥠 ${getPileWisdom()}\n`);
  });

// Easter egg: what is pile?
program
  .command("wtf", { hidden: true })
  .description("What is this pile?")
  .action(() => {
    console.log(`
  pile (noun): /paɪl/

  1. A heap of things laid on top of one another
     "a pile of PRs waiting for review"

  2. A large amount of something
     "I've got a pile of work to do"

  3. (informal) A large imposing building
     "this codebase is quite a pile"

  4. (slang) Something of poor quality
     "if the tests fail, it's a pile of..."

  Usage: You decide which definition applies to your code.
`);
  });

program.parse();
