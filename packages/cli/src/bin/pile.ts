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
import { getSecretPileMessage, getPileWisdom } from "../utils/fun.js";

const program = new Command();

program.name("pile").description("AI-native stacked PR CLI").version("0.2.0");

program.option("--json", "Output in JSON format for AI agents", false);

// init command
program
  .command("init")
  .description("Initialize pile in the current repository")
  .option(
    "-t, --trunk <branch>",
    "Trunk branch name (default: auto-detect main/master)",
  )
  .option("--open-pr", "Automatically open PR links in browser after submit")
  .action((opts) => {
    const globalOpts = program.opts();
    render(
      React.createElement(InitCommand, {
        trunk: opts.trunk,
        openPr: opts.openPr,
        options: { json: globalOpts.json },
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
        options: { json: globalOpts.json },
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
        options: { json: globalOpts.json },
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
        options: { json: globalOpts.json },
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
        options: { json: globalOpts.json },
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
        options: { json: globalOpts.json },
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
        options: { json: globalOpts.json },
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
        options: { json: globalOpts.json },
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
        options: { json: globalOpts.json },
      }),
    );
  });

// status command
program
  .command("status")
  .alias("st")
  .description("Show PR status for the current branch")
  .action(() => {
    const globalOpts = program.opts();
    render(
      React.createElement(StatusCommand, {
        options: { json: globalOpts.json },
      }),
    );
  });

// diff command
program
  .command("diff")
  .alias("d")
  .description("Show changes in current branch compared to its parent")
  .action(() => {
    const globalOpts = program.opts();
    render(
      React.createElement(DiffCommand, {
        options: { json: globalOpts.json },
      }),
    );
  });

// merge command
program
  .command("merge")
  .description("Merge the current branch's PR (squash by default)")
  .option("-f, --force", "Merge even if checks are failing or reviews pending")
  .action((opts) => {
    const globalOpts = program.opts();
    render(
      React.createElement(MergeCommand, {
        force: opts.force,
        options: { json: globalOpts.json },
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
        options: { json: globalOpts.json },
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
        options: { json: globalOpts.json },
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
        options: { json: globalOpts.json },
      }),
    );
  });

// close command
program
  .command("close")
  .description("Close the current branch's PR without merging")
  .option("--reopen", "Reopen a closed PR")
  .action((opts) => {
    const globalOpts = program.opts();
    render(
      React.createElement(CloseCommand, {
        reopen: opts.reopen,
        options: { json: globalOpts.json },
      }),
    );
  });

// delete command
program
  .command("delete")
  .alias("del")
  .description("Delete the current branch, close its PR, and switch to parent")
  .option("-f, --force", "Force delete even if branch has children (reparents them)")
  .action((opts) => {
    const globalOpts = program.opts();
    render(
      React.createElement(DeleteCommand, {
        force: opts.force,
        options: { json: globalOpts.json },
      }),
    );
  });

// edit command
program
  .command("edit")
  .description("Edit the current branch's PR metadata")
  .option("-t, --title <title>", "Update PR title")
  .option("-b, --body [body]", "Update PR body (use '-' for stdin, omit value for editor)")
  .option("--draft", "Convert PR to draft")
  .option("--ready", "Mark PR as ready for review")
  .option("--labels <labels>", "Set labels (comma-separated, replaces existing)")
  .option("--add-labels <labels>", "Add labels (comma-separated, keeps existing)")
  .option("--assignees <assignees>", "Set assignees (comma-separated)")
  .option("--milestone <milestone>", "Set milestone")
  .action(async (opts) => {
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
        title: opts.title,
        body: body,
        draft: opts.draft,
        ready: opts.ready,
        labels: opts.labels,
        addLabels: opts.addLabels,
        assignees: opts.assignees,
        milestone: opts.milestone,
        options: { json: globalOpts.json },
      }),
    );
  });

// request command
program
  .command("request [reviewers...]")
  .description("Request review on the current branch's PR")
  .option("-t, --team <teams...>", "Request review from teams")
  .action((reviewers, opts) => {
    const globalOpts = program.opts();
    render(
      React.createElement(RequestCommand, {
        reviewers: reviewers || [],
        teams: opts.team,
        options: { json: globalOpts.json },
      }),
    );
  });

// review command
program
  .command("review")
  .description("Submit a review on the current branch's PR")
  .option("--approve", "Approve the PR")
  .option("--request-changes", "Request changes on the PR")
  .option("-m, --message <message>", "Review comment/message")
  .action((opts) => {
    const globalOpts = program.opts();
    render(
      React.createElement(ReviewCommand, {
        approve: opts.approve,
        requestChanges: opts.requestChanges,
        message: opts.message,
        options: { json: globalOpts.json },
      }),
    );
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
