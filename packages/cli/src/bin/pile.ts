#!/usr/bin/env node
import { Command } from "commander";
import { render } from "ink";
import React from "react";

import { InitCommand } from "../commands/init.js";
import { CreateCommand } from "../commands/create.js";
import { LogCommand } from "../commands/log.js";
import { NavigateCommand } from "../commands/navigate.js";
import { SubmitCommand } from "../commands/submit.js";
import { SyncCommand } from "../commands/sync.js";
import { CheckoutCommand } from "../commands/checkout.js";
import { BranchesCommand } from "../commands/branches.js";
import { ModifyCommand } from "../commands/modify.js";
import { StatusCommand } from "../commands/status.js";
import { MergeCommand } from "../commands/merge.js";
import { RestackCommand } from "../commands/restack.js";
import { AddCommand } from "../commands/add.js";

const program = new Command();

program
  .name("pile")
  .description("AI-native stacked PR CLI")
  .version("0.1.0");

program.option("--json", "Output in JSON format for AI agents", false);

// init command
program
  .command("init")
  .description("Initialize pile in the current repository")
  .option(
    "-t, --trunk <branch>",
    "Trunk branch name (default: auto-detect main/master)"
  )
  .option(
    "--open-pr",
    "Automatically open PR links in browser after submit"
  )
  .action((opts) => {
    const globalOpts = program.opts();
    render(
      React.createElement(InitCommand, {
        trunk: opts.trunk,
        openPr: opts.openPr,
        options: { json: globalOpts.json },
      })
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
      })
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
  .option("-i, --insert", "Insert branch between current branch and its children")
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
      })
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
      })
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
      })
    );
  });

// ls command (alias for log)
program
  .command("ls")
  .description("Display the current stack (alias for log)")
  .action(() => {
    const globalOpts = program.opts();
    render(
      React.createElement(LogCommand, {
        options: { json: globalOpts.json },
      })
    );
  });

// up command
program
  .command("up [steps]")
  .alias("u")
  .description("Navigate up the stack (to child branch)")
  .action((steps) => {
    const globalOpts = program.opts();
    render(
      React.createElement(NavigateCommand, {
        direction: "up",
        steps: steps ? parseInt(steps, 10) : 1,
        options: { json: globalOpts.json },
      })
    );
  });

// down command
program
  .command("down [steps]")
  .alias("d")
  .description("Navigate down the stack (to parent branch)")
  .action((steps) => {
    const globalOpts = program.opts();
    render(
      React.createElement(NavigateCommand, {
        direction: "down",
        steps: steps ? parseInt(steps, 10) : 1,
        options: { json: globalOpts.json },
      })
    );
  });

// top command
program
  .command("top")
  .description("Navigate to the top of the stack")
  .action(() => {
    const globalOpts = program.opts();
    render(
      React.createElement(NavigateCommand, {
        direction: "top",
        options: { json: globalOpts.json },
      })
    );
  });

// bottom command
program
  .command("bottom")
  .description("Navigate to the trunk branch")
  .action(() => {
    const globalOpts = program.opts();
    render(
      React.createElement(NavigateCommand, {
        direction: "bottom",
        options: { json: globalOpts.json },
      })
    );
  });

// submit command
program
  .command("submit")
  .alias("s")
  .description("Push branch and create/update pull request")
  .option(
    "-s, --stack",
    "Submit entire stack (all branches from trunk to current)"
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
      })
    );
  });

// ss command (submit stack shortcut)
program
  .command("ss")
  .description("Submit entire stack (alias for submit --stack)")
  .option("-d, --draft", "Create PRs as draft")
  .option("-r, --reviewers <reviewers...>", "Request reviewers")
  .option("-o, --open", "Open PRs in browser after creating")
  .action((opts) => {
    const globalOpts = program.opts();
    render(
      React.createElement(SubmitCommand, {
        stack: true,
        draft: opts.draft,
        reviewers: opts.reviewers,
        open: opts.open,
        options: { json: globalOpts.json },
      })
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
      })
    );
  });

// co command (checkout)
program
  .command("co")
  .description("Interactive branch selector - navigate and checkout branches")
  .action(() => {
    const globalOpts = program.opts();
    render(
      React.createElement(CheckoutCommand, {
        options: { json: globalOpts.json },
      })
    );
  });

// branches command
program
  .command("branches")
  .alias("br")
  .description("View and manage all branches - track/untrack branches for stacking")
  .action(() => {
    const globalOpts = program.opts();
    render(
      React.createElement(BranchesCommand, {
        options: { json: globalOpts.json },
      })
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
      })
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
      })
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
      })
    );
  });

program.parse();
