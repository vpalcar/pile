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
  .action((opts) => {
    const globalOpts = program.opts();
    render(
      React.createElement(InitCommand, {
        trunk: opts.trunk,
        options: { json: globalOpts.json },
      })
    );
  });

// create command
program
  .command("create <name>")
  .alias("c")
  .description("Create a new stacked branch")
  .option("-m, --message <message>", "Commit message for staged changes")
  .option("-a, --all", "Stage all changes before creating branch")
  .action((name, opts) => {
    const globalOpts = program.opts();
    render(
      React.createElement(CreateCommand, {
        name,
        message: opts.message,
        all: opts.all,
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
  .action((opts) => {
    const globalOpts = program.opts();
    render(
      React.createElement(SubmitCommand, {
        stack: opts.stack,
        draft: opts.draft,
        title: opts.title,
        reviewers: opts.reviewers,
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
  .action((opts) => {
    const globalOpts = program.opts();
    render(
      React.createElement(SubmitCommand, {
        stack: true,
        draft: opts.draft,
        reviewers: opts.reviewers,
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

program.parse();
