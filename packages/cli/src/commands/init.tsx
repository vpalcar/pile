import React, { useState, useEffect } from "react";
import { Box, Text, useInput, useApp } from "ink";
import { createPile, createGitOperations, PileInstance } from "@pile/core";
import { getGitHubToken, getGitHubConfig, createGitHubRepo as createGitHubRepoAPI, getGitHubUserInfo, type GitHubUser } from "@pile/github";
import { Spinner } from "../components/Spinner.js";
import {
  SuccessMessage,
  ErrorMessage,
  WarningMessage,
  InfoMessage,
} from "../components/Message.js";
import { OutputOptions, formatJson, createResult } from "../utils/output.js";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

function ensureGitignore(repoRoot: string) {
  const gitignorePath = join(repoRoot, ".gitignore");
  const entry = ".pile/";
  if (existsSync(gitignorePath)) {
    const content = readFileSync(gitignorePath, "utf-8");
    if (!content.split("\n").some((line) => line.trim() === entry)) {
      writeFileSync(gitignorePath, content.trimEnd() + "\n" + entry + "\n");
    }
  } else {
    writeFileSync(gitignorePath, entry + "\n");
  }
}

export interface InitCommandProps {
  trunk?: string;
  openPr?: boolean;
  options: OutputOptions;
}

type WizardStep =
  | "welcome"
  | "checking_git"
  | "init_git_prompt"
  | "init_git"
  | "select_trunk"
  | "checking_remote"
  | "setup_remote_prompt"
  | "add_remote_input"
  | "loading_user_info"
  | "create_repo_name"
  | "create_repo_visibility"
  | "create_repo_owner"
  | "creating_repo"
  | "adding_remote"
  | "checking_auth"
  | "auth_help"
  | "select_merge_method"
  | "auto_open_prompt"
  | "initializing"
  | "summary"
  | "already_initialized"
  | "error";

interface WizardState {
  isGitRepo: boolean;
  hasCommits: boolean;
  branches: string[];
  selectedTrunk: string;
  trunkIndex: number;
  hasRemote: boolean;
  remoteUrl: string | null;
  remoteInput: string;
  isGitHubRemote: boolean;
  hasGitHubAuth: boolean;
  authMethod: string | null;
  mergeMethod: "squash" | "merge" | "rebase";
  mergeMethodIndex: number;
  remoteOptionIndex: number;
  autoOpenPR: boolean;
  // Repo creation
  repoName: string;
  repoIsPrivate: boolean;
  repoVisibilityIndex: number;
  repoOwners: Array<{ login: string; name: string | null; isOrg: boolean }>;
  repoOwnerIndex: number;
  githubUser: GitHubUser | null;
}

const MERGE_METHODS = [
  { value: "squash", label: "Squash", desc: "Combine all commits into one (recommended)" },
  { value: "merge", label: "Merge", desc: "Create a merge commit" },
  { value: "rebase", label: "Rebase", desc: "Rebase commits onto base" },
] as const;

const WELCOME_ART = `
       ██████╗ ██╗██╗     ███████╗
       ██╔══██╗██║██║     ██╔════╝
       ██████╔╝██║██║     █████╗
       ██╔═══╝ ██║██║     ██╔══╝
       ██║     ██║███████╗███████╗
       ╚═╝     ╚═╝╚══════╝╚══════╝

     ┌─────────────────────────────┐
     │  The AI-native stacked PR   │
     │      CLI for humans         │
     └─────────────────────────────┘
`;

const SUCCESS_ART = `
     ╔═══════════════════════════════╗
     ║   ✨ Pile is ready to go! ✨  ║
     ╚═══════════════════════════════╝
`;

const STACK_ART = `
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
`;

export function InitCommand({
  trunk,
  openPr,
  options,
}: InitCommandProps): React.ReactElement {
  const { exit } = useApp();
  const [step, setStep] = useState<WizardStep>("welcome");
  const [pile, setPile] = useState<PileInstance | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [wizardState, setWizardState] = useState<WizardState>({
    isGitRepo: false,
    hasCommits: false,
    branches: [],
    selectedTrunk: trunk ?? "main",
    trunkIndex: 0,
    hasRemote: false,
    remoteUrl: null,
    remoteInput: "",
    isGitHubRemote: false,
    hasGitHubAuth: false,
    authMethod: null,
    mergeMethod: "squash",
    mergeMethodIndex: 0,
    remoteOptionIndex: 0,
    autoOpenPR: openPr ?? false,
    // Repo creation
    repoName: process.cwd().split("/").pop() || "my-repo",
    repoIsPrivate: false,
    repoVisibilityIndex: 0,
    repoOwners: [],
    repoOwnerIndex: 0,
    githubUser: null,
  });

  // Handle non-interactive mode (--json or with flags)
  useEffect(() => {
    if (options.json || trunk) {
      runNonInteractive();
    }
  }, []);

  async function runNonInteractive() {
    try {
      // First check if we're in a git repo and init if needed
      const git = createGitOperations(process.cwd());
      const isGitRepo = await git.isGitRepo();
      if (!isGitRepo) {
        await git.initRepo();
      }

      // Now create the full pile instance
      const pileInstance = await createPile();

      if (pileInstance.state.isInitialized()) {
        const config = pileInstance.state.getConfig();
        if (options.json) {
          console.log(
            formatJson(
              createResult(
                true,
                { trunk: config?.trunk, autoOpenPR: config?.autoOpenPR },
                undefined,
                "Already initialized"
              )
            )
          );
          process.exit(0);
        }
        setWizardState((s) => ({ ...s, selectedTrunk: config?.trunk ?? "main" }));
        setStep("already_initialized");
        return;
      }

      const branches = await pileInstance.git.getAllBranches();
      let defaultTrunk: string;

      if (branches.length === 0) {
        defaultTrunk = trunk ?? "main";
        await pileInstance.git.createInitialCommit(defaultTrunk);
      } else {
        defaultTrunk =
          trunk ??
          (branches.includes("main")
            ? "main"
            : branches.includes("master")
              ? "master"
              : branches[0]);
      }

      pileInstance.state.saveConfig({
        trunk: defaultTrunk,
        remote: "origin",
        initialized: true,
        autoOpenPR: openPr ?? false,
        mergeMethod: "squash",
      });

      const repoRoot = await git.getRepoRoot();
      ensureGitignore(repoRoot);

      if (options.json) {
        console.log(
          formatJson(
            createResult(
              true,
              { trunk: defaultTrunk, autoOpenPR: openPr ?? false },
              undefined,
              "Initialized"
            )
          )
        );
        process.exit(0);
      }

      setWizardState((s) => ({ ...s, selectedTrunk: defaultTrunk }));
      setStep("summary");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (options.json) {
        console.log(formatJson(createResult(false, null, message)));
        process.exit(1);
      }
      setError(message);
      setStep("error");
    }
  }

  // No auto-advance - welcome is now interactive

  async function checkGitRepo() {
    try {
      // First check if we're in a git repo
      const git = createGitOperations(process.cwd());
      const isGitRepo = await git.isGitRepo();

      if (!isGitRepo) {
        setWizardState((s) => ({ ...s, isGitRepo: false }));
        setStep("init_git_prompt");
        return;
      }

      // Now create the full pile instance
      const pileInstance = await createPile();
      setPile(pileInstance);

      // Check if already initialized
      if (pileInstance.state.isInitialized()) {
        const config = pileInstance.state.getConfig();
        setWizardState((s) => ({ ...s, selectedTrunk: config?.trunk ?? "main" }));
        setStep("already_initialized");
        return;
      }

      const branches = await pileInstance.git.getAllBranches();
      const hasCommits = branches.length > 0;

      // Find default trunk
      let defaultTrunk = "main";
      let trunkIndex = 0;
      if (branches.includes("main")) {
        defaultTrunk = "main";
        trunkIndex = branches.indexOf("main");
      } else if (branches.includes("master")) {
        defaultTrunk = "master";
        trunkIndex = branches.indexOf("master");
      } else if (branches.length > 0) {
        defaultTrunk = branches[0];
        trunkIndex = 0;
      }

      setWizardState((s) => ({
        ...s,
        isGitRepo: true,
        hasCommits,
        branches,
        selectedTrunk: defaultTrunk,
        trunkIndex,
      }));

      if (hasCommits) {
        setStep("select_trunk");
      } else {
        // No commits, will create initial commit
        setStep("select_trunk");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStep("error");
    }
  }

  async function initGitRepo() {
    setStep("init_git");
    try {
      const git = createGitOperations(process.cwd());
      await git.initRepo();

      // Now create pile instance
      const pileInstance = await createPile();
      setPile(pileInstance);

      setWizardState((s) => ({
        ...s,
        isGitRepo: true,
        hasCommits: false,
        branches: [],
      }));
      setTimeout(() => setStep("select_trunk"), 500);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStep("error");
    }
  }

  async function checkRemote() {
    setStep("checking_remote");
    try {
      // Check for auth early so we know if we can offer repo creation
      const token = getGitHubToken();
      const hasAuth = !!token;

      const repoRoot = pile ? await pile.git.getRepoRoot() : process.cwd();
      const config = await getGitHubConfig(repoRoot);

      if (config) {
        setWizardState((s) => ({
          ...s,
          hasRemote: true,
          isGitHubRemote: true,
          hasGitHubAuth: hasAuth,
          remoteUrl: `github.com/${config.owner}/${config.repo}`,
        }));
        checkAuth();
      } else {
        // Try to get remote URL directly
        try {
          const remoteUrl = execSync("git remote get-url origin 2>/dev/null", {
            encoding: "utf-8",
          }).trim();
          const isGitHub = remoteUrl.includes("github.com");
          setWizardState((s) => ({
            ...s,
            hasRemote: true,
            remoteUrl,
            isGitHubRemote: isGitHub,
            hasGitHubAuth: hasAuth,
          }));
          if (isGitHub) {
            checkAuth();
          } else {
            setStep("setup_remote_prompt");
          }
        } catch {
          setWizardState((s) => ({ ...s, hasRemote: false, hasGitHubAuth: hasAuth }));
          setStep("setup_remote_prompt");
        }
      }
    } catch (err) {
      const token = getGitHubToken();
      setWizardState((s) => ({ ...s, hasRemote: false, hasGitHubAuth: !!token }));
      setStep("setup_remote_prompt");
    }
  }

  async function startRepoCreation() {
    setStep("loading_user_info");
    try {
      const token = getGitHubToken();
      if (!token) {
        setError("GitHub authentication required. Set GITHUB_TOKEN environment variable.");
        setStep("error");
        return;
      }

      // Fetch user info to get orgs
      const userInfo = await getGitHubUserInfo(token);

      // Build list of possible owners (personal account + orgs)
      const owners: Array<{ login: string; name: string | null; isOrg: boolean }> = [
        { login: userInfo.login, name: userInfo.name, isOrg: false },
        ...userInfo.orgs.map((org) => ({ login: org.login, name: org.name, isOrg: true })),
      ];

      setWizardState((s) => ({
        ...s,
        githubUser: userInfo,
        repoOwners: owners,
        repoOwnerIndex: 0,
      }));

      setStep("create_repo_name");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(`Failed to fetch user info: ${message}`);
      setStep("error");
    }
  }

  async function createGitHubRepo() {
    setStep("creating_repo");
    try {
      const token = getGitHubToken();
      if (!token) {
        setError("GitHub authentication required. Set GITHUB_TOKEN environment variable.");
        setStep("error");
        return;
      }

      // Get selected owner
      const selectedOwner = wizardState.repoOwners[wizardState.repoOwnerIndex];
      const isOrg = selectedOwner?.isOrg ?? false;

      // Create repo via GitHub API
      const result = await createGitHubRepoAPI(token, {
        name: wizardState.repoName,
        private: wizardState.repoIsPrivate,
        org: isOrg ? selectedOwner.login : undefined,
      });

      // Add remote origin
      execSync(`git remote add origin ${result.httpsUrl}`, {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });

      // Push to remote
      const currentBranch = wizardState.selectedTrunk || "main";
      try {
        execSync(`git push -u origin ${currentBranch}`, {
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch {
        // Push might fail if no commits yet, that's ok
      }

      setWizardState((s) => ({
        ...s,
        hasRemote: true,
        isGitHubRemote: true,
        remoteUrl: result.url,
      }));

      checkAuth();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("name already exists")) {
        setError(`Repository "${wizardState.repoName}" already exists on GitHub.`);
      } else if (message.includes("401") || message.includes("Bad credentials")) {
        setError("Invalid GitHub token. Check your GITHUB_TOKEN environment variable.");
      } else {
        setError(`Failed to create repo: ${message}`);
      }
      setStep("error");
    }
  }

  async function addRemote() {
    setStep("adding_remote");
    try {
      const remoteUrl = wizardState.remoteInput.trim();

      // Add remote origin
      execSync(`git remote add origin ${remoteUrl}`, {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });

      const isGitHub = remoteUrl.includes("github.com");

      setWizardState((s) => ({
        ...s,
        hasRemote: true,
        isGitHubRemote: isGitHub,
        remoteUrl,
      }));

      // Push if we have commits
      if (wizardState.hasCommits) {
        try {
          const currentBranch = wizardState.selectedTrunk || "main";
          execSync(`git push -u origin ${currentBranch}`, {
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
          });
        } catch {
          // Push might fail, that's ok
        }
      }

      checkAuth();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("already exists")) {
        setError("Remote 'origin' already exists. Remove it first with: git remote remove origin");
      } else {
        setError(`Failed to add remote: ${message}`);
      }
      setStep("error");
    }
  }

  async function checkAuth() {
    setStep("checking_auth");
    try {
      const token = getGitHubToken();
      if (token) {
        // Determine auth method
        let method = "environment variable";
        if (process.env.GITHUB_TOKEN) {
          method = "GITHUB_TOKEN";
        } else if (process.env.GH_TOKEN) {
          method = "GH_TOKEN";
        } else {
          method = "gh CLI";
        }
        setWizardState((s) => ({
          ...s,
          hasGitHubAuth: true,
          authMethod: method,
        }));
        setStep("select_merge_method");
      } else {
        setWizardState((s) => ({ ...s, hasGitHubAuth: false }));
        setStep("auth_help");
      }
    } catch {
      setWizardState((s) => ({ ...s, hasGitHubAuth: false }));
      setStep("auth_help");
    }
  }

  async function finishSetup() {
    if (!pile) return;
    setStep("initializing");
    try {
      // Create initial commit if needed
      if (!wizardState.hasCommits) {
        await pile.git.createInitialCommit(wizardState.selectedTrunk);
      }

      // Push trunk to remote if we have one (needed for new repos)
      if (wizardState.hasRemote) {
        try {
          execSync(`git push -u origin ${wizardState.selectedTrunk}`, {
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
          });
        } catch {
          // Push might fail, that's ok - user can push manually
        }
      }

      pile.state.saveConfig({
        trunk: wizardState.selectedTrunk,
        remote: "origin",
        initialized: true,
        autoOpenPR: wizardState.autoOpenPR,
        mergeMethod: wizardState.mergeMethod,
      });

      const repoRoot = await pile.git.getRepoRoot();
      ensureGitignore(repoRoot);

      setTimeout(() => setStep("summary"), 500);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStep("error");
    }
  }

  // Input handling for different steps
  useInput(
    (input, key) => {
      if (step === "welcome") {
        if (key.return) {
          setStep("checking_git");
          checkGitRepo();
        } else if (key.escape) {
          exit();
        }
      } else if (step === "init_git_prompt") {
        if (input === "y" || key.return) {
          initGitRepo();
        } else if (input === "n" || key.escape) {
          exit();
        }
      } else if (step === "select_trunk") {
        const { branches, trunkIndex } = wizardState;
        const options = branches.length > 0 ? branches : ["main", "master"];

        if (key.upArrow) {
          const newIndex = Math.max(0, trunkIndex - 1);
          setWizardState((s) => ({
            ...s,
            trunkIndex: newIndex,
            selectedTrunk: options[newIndex],
          }));
        } else if (key.downArrow) {
          const newIndex = Math.min(options.length - 1, trunkIndex + 1);
          setWizardState((s) => ({
            ...s,
            trunkIndex: newIndex,
            selectedTrunk: options[newIndex],
          }));
        } else if (key.return) {
          checkRemote();
        } else if (key.escape) {
          exit();
        }
      } else if (step === "setup_remote_prompt") {
        const maxIndex = wizardState.hasGitHubAuth ? 2 : 1; // 3 options if auth, 2 if not

        if (key.upArrow) {
          setWizardState((s) => ({
            ...s,
            remoteOptionIndex: Math.max(0, s.remoteOptionIndex - 1),
          }));
        } else if (key.downArrow) {
          setWizardState((s) => ({
            ...s,
            remoteOptionIndex: Math.min(maxIndex, s.remoteOptionIndex + 1),
          }));
        } else if (key.return) {
          if (wizardState.hasGitHubAuth) {
            // 3 options: Create, Add existing, Skip
            if (wizardState.remoteOptionIndex === 0) {
              startRepoCreation();
            } else if (wizardState.remoteOptionIndex === 1) {
              setStep("add_remote_input");
            } else {
              checkAuth();
            }
          } else {
            // 2 options: Add existing, Skip
            if (wizardState.remoteOptionIndex === 0) {
              setStep("add_remote_input");
            } else {
              checkAuth();
            }
          }
        } else if (key.escape) {
          exit();
        }
      } else if (step === "create_repo_name") {
        if (key.return && wizardState.repoName.trim()) {
          setStep("create_repo_visibility");
        } else if (key.escape) {
          setStep("setup_remote_prompt");
        } else if (key.backspace || key.delete) {
          setWizardState((s) => ({
            ...s,
            repoName: s.repoName.slice(0, -1),
          }));
        } else if (input && !key.ctrl && !key.meta) {
          setWizardState((s) => ({
            ...s,
            repoName: s.repoName + input,
          }));
        }
      } else if (step === "create_repo_visibility") {
        if (key.upArrow || key.downArrow) {
          setWizardState((s) => ({
            ...s,
            repoVisibilityIndex: s.repoVisibilityIndex === 0 ? 1 : 0,
            repoIsPrivate: s.repoVisibilityIndex === 0,
          }));
        } else if (key.return) {
          // If user has orgs, show owner selection
          if (wizardState.repoOwners.length > 1) {
            setStep("create_repo_owner");
          } else {
            createGitHubRepo();
          }
        } else if (key.escape) {
          setStep("create_repo_name");
        }
      } else if (step === "create_repo_owner") {
        const maxOwnerIndex = wizardState.repoOwners.length - 1;

        if (key.upArrow) {
          setWizardState((s) => ({
            ...s,
            repoOwnerIndex: Math.max(0, s.repoOwnerIndex - 1),
          }));
        } else if (key.downArrow) {
          setWizardState((s) => ({
            ...s,
            repoOwnerIndex: Math.min(maxOwnerIndex, s.repoOwnerIndex + 1),
          }));
        } else if (key.return) {
          createGitHubRepo();
        } else if (key.escape) {
          setStep("create_repo_visibility");
        }
      } else if (step === "add_remote_input") {
        if (key.return && wizardState.remoteInput.trim()) {
          addRemote();
        } else if (key.escape) {
          setStep("setup_remote_prompt");
        } else if (key.backspace || key.delete) {
          setWizardState((s) => ({
            ...s,
            remoteInput: s.remoteInput.slice(0, -1),
          }));
        } else if (input && !key.ctrl && !key.meta) {
          setWizardState((s) => ({
            ...s,
            remoteInput: s.remoteInput + input,
          }));
        }
      } else if (step === "auth_help") {
        if (key.return) {
          // Continue anyway
          setStep("select_merge_method");
        } else if (key.escape) {
          exit();
        }
      } else if (step === "select_merge_method") {
        const { mergeMethodIndex } = wizardState;

        if (key.upArrow) {
          const newIndex = Math.max(0, mergeMethodIndex - 1);
          setWizardState((s) => ({
            ...s,
            mergeMethodIndex: newIndex,
            mergeMethod: MERGE_METHODS[newIndex].value,
          }));
        } else if (key.downArrow) {
          const newIndex = Math.min(MERGE_METHODS.length - 1, mergeMethodIndex + 1);
          setWizardState((s) => ({
            ...s,
            mergeMethodIndex: newIndex,
            mergeMethod: MERGE_METHODS[newIndex].value,
          }));
        } else if (key.return) {
          setStep("auto_open_prompt");
        } else if (key.escape) {
          exit();
        }
      } else if (step === "auto_open_prompt") {
        if (input === "y" || input === "Y") {
          setWizardState((s) => ({ ...s, autoOpenPR: true }));
          finishSetup();
        } else if (input === "n" || input === "N" || key.return) {
          setWizardState((s) => ({ ...s, autoOpenPR: false }));
          finishSetup();
        } else if (key.escape) {
          exit();
        }
      } else if (step === "summary" || step === "already_initialized") {
        if (key.return || key.escape) {
          exit();
        }
      }
    },
    {
      isActive: !options.json && !trunk && [
        "welcome",
        "init_git_prompt",
        "select_trunk",
        "setup_remote_prompt",
        "add_remote_input",
        "create_repo_name",
        "create_repo_visibility",
        "create_repo_owner",
        "auth_help",
        "select_merge_method",
        "auto_open_prompt",
        "summary",
        "already_initialized",
      ].includes(step),
    }
  );

  if (options.json) {
    return <></>;
  }

  // Render based on current step
  switch (step) {
    case "welcome":
      return (
        <Box flexDirection="column">
          <Text color="cyan">{WELCOME_ART}</Text>
          <Text color="gray" dimColor>{STACK_ART}</Text>
          <Box marginTop={1}>
            <Text>Press </Text>
            <Text color="cyan">enter</Text>
            <Text> to set up pile in this directory</Text>
          </Box>
        </Box>
      );

    case "checking_git":
      return <Spinner label="Checking git repository..." />;

    case "init_git_prompt":
      return (
        <Box flexDirection="column">
          <Text color="cyan">{WELCOME_ART}</Text>
          <WarningMessage>This directory is not a git repository.</WarningMessage>
          <Box marginTop={1}>
            <Text>Initialize a new git repository? </Text>
            <Text color="cyan">[Y/n]</Text>
          </Box>
        </Box>
      );

    case "init_git":
      return <Spinner label="Initializing git repository..." />;

    case "select_trunk": {
      const options =
        wizardState.branches.length > 0
          ? wizardState.branches
          : ["main", "master"];

      return (
        <Box flexDirection="column">
          <Text color="cyan">{WELCOME_ART}</Text>
          <Box marginBottom={1}>
            <Text bold>Select trunk branch</Text>
            <Text color="gray"> (your main branch)</Text>
          </Box>
          <Text color="gray" dimColor>
            ↑↓ navigate  enter select
          </Text>
          <Box flexDirection="column" marginTop={1}>
            {options.map((branch, index) => {
              const isSelected = index === wizardState.trunkIndex;
              const isRecommended =
                branch === "main" || (branch === "master" && !options.includes("main"));

              return (
                <Box key={branch}>
                  <Text color={isSelected ? "cyan" : undefined}>
                    {isSelected ? "› " : "  "}
                  </Text>
                  <Text color={isSelected ? "cyan" : undefined} bold={isSelected}>
                    {branch}
                  </Text>
                  {isRecommended && (
                    <Text color="gray" dimColor>
                      {" "}
                      (recommended)
                    </Text>
                  )}
                </Box>
              );
            })}
          </Box>
        </Box>
      );
    }

    case "checking_remote":
      return <Spinner label="Checking GitHub remote..." />;

    case "setup_remote_prompt": {
      // Build options based on auth state
      const remoteOptions = wizardState.hasGitHubAuth
        ? [
            { label: `Create new repo "${wizardState.repoName}" on GitHub`, value: "create" },
            { label: "Add existing remote URL", value: "add" },
            { label: "Skip for now", value: "skip" },
          ]
        : [
            { label: "Add existing remote URL", value: "add" },
            { label: "Skip for now", value: "skip" },
          ];

      return (
        <Box flexDirection="column">
          <Text color="cyan">{WELCOME_ART}</Text>
          <Box marginBottom={1}>
            <Text bold>GitHub remote</Text>
          </Box>
          <Text color="gray" dimColor>
            ↑↓ navigate  enter select
          </Text>
          <Box flexDirection="column" marginTop={1}>
            {remoteOptions.map((opt, index) => {
              const isSelected = index === wizardState.remoteOptionIndex;
              return (
                <Box key={opt.value}>
                  <Text color={isSelected ? "cyan" : undefined}>
                    {isSelected ? "› " : "  "}
                  </Text>
                  <Text color={isSelected ? "cyan" : undefined} bold={isSelected}>
                    {opt.label}
                  </Text>
                </Box>
              );
            })}
          </Box>
          {!wizardState.hasGitHubAuth && (
            <Box marginTop={1} flexDirection="column">
              <Text color="gray" dimColor>
                To create repos, set GITHUB_TOKEN environment variable
              </Text>
            </Box>
          )}
        </Box>
      );
    }

    case "add_remote_input":
      return (
        <Box flexDirection="column">
          <Text color="cyan">{WELCOME_ART}</Text>
          <Box flexDirection="column">
            <Text bold>Add GitHub remote</Text>
            <Box marginTop={1}>
              <Text color="gray">Enter repository URL (e.g., https://github.com/user/repo.git):</Text>
            </Box>
            <Box marginTop={1}>
              <Text color="cyan">› </Text>
              <Text>{wizardState.remoteInput}</Text>
              <Text color="cyan">█</Text>
            </Box>
            <Box marginTop={1}>
              <Text color="gray" dimColor>enter confirm  esc back</Text>
            </Box>
          </Box>
        </Box>
      );

    case "loading_user_info":
      return (
        <Box flexDirection="column">
          <Text color="cyan">{WELCOME_ART}</Text>
          <Spinner label="Loading GitHub account info..." />
        </Box>
      );

    case "create_repo_name":
      return (
        <Box flexDirection="column">
          <Text color="cyan">{WELCOME_ART}</Text>
          <Box flexDirection="column">
            <Text bold>Create GitHub repository</Text>
            <Box marginTop={1}>
              <Text color="gray">Repository name:</Text>
            </Box>
            <Box marginTop={1}>
              <Text color="cyan">› </Text>
              <Text>{wizardState.repoName}</Text>
              <Text color="cyan">█</Text>
            </Box>
            <Box marginTop={1}>
              <Text color="gray" dimColor>enter confirm  esc back</Text>
            </Box>
          </Box>
        </Box>
      );

    case "create_repo_visibility": {
      const visibilityOptions = [
        { label: "Public", desc: "Anyone can see this repository" },
        { label: "Private", desc: "Only you and collaborators can access" },
      ];

      return (
        <Box flexDirection="column">
          <Text color="cyan">{WELCOME_ART}</Text>
          <Box flexDirection="column">
            <Text bold>Repository visibility</Text>
            <Text color="gray" dimColor>
              ↑↓ navigate  enter select  esc back
            </Text>
            <Box flexDirection="column" marginTop={1}>
              {visibilityOptions.map((opt, index) => {
                const isSelected = index === wizardState.repoVisibilityIndex;
                return (
                  <Box key={opt.label}>
                    <Text color={isSelected ? "cyan" : undefined}>
                      {isSelected ? "› " : "  "}
                    </Text>
                    <Text color={isSelected ? "cyan" : undefined} bold={isSelected}>
                      {opt.label}
                    </Text>
                    <Text color="gray" dimColor>
                      {" "}- {opt.desc}
                    </Text>
                  </Box>
                );
              })}
            </Box>
          </Box>
        </Box>
      );
    }

    case "create_repo_owner": {
      return (
        <Box flexDirection="column">
          <Text color="cyan">{WELCOME_ART}</Text>
          <Box flexDirection="column">
            <Text bold>Where to create the repository?</Text>
            <Text color="gray" dimColor>
              ↑↓ navigate  enter select  esc back
            </Text>
            <Box flexDirection="column" marginTop={1}>
              {wizardState.repoOwners.map((owner, index) => {
                const isSelected = index === wizardState.repoOwnerIndex;
                return (
                  <Box key={owner.login}>
                    <Text color={isSelected ? "cyan" : undefined}>
                      {isSelected ? "› " : "  "}
                    </Text>
                    <Text color={isSelected ? "cyan" : undefined} bold={isSelected}>
                      {owner.login}
                    </Text>
                    {owner.isOrg && (
                      <Text color="gray" dimColor> (organization)</Text>
                    )}
                    {!owner.isOrg && (
                      <Text color="gray" dimColor> (personal)</Text>
                    )}
                    {owner.name && (
                      <Text color="gray" dimColor> - {owner.name}</Text>
                    )}
                  </Box>
                );
              })}
            </Box>
          </Box>
        </Box>
      );
    }

    case "creating_repo": {
      const owner = wizardState.repoOwners[wizardState.repoOwnerIndex];
      const repoPath = owner ? `${owner.login}/${wizardState.repoName}` : wizardState.repoName;
      return (
        <Box flexDirection="column">
          <Text color="cyan">{WELCOME_ART}</Text>
          <Spinner label={`Creating ${repoPath}...`} />
        </Box>
      );
    }

    case "adding_remote":
      return (
        <Box flexDirection="column">
          <Text color="cyan">{WELCOME_ART}</Text>
          <Spinner label="Adding remote and pushing..." />
        </Box>
      );

    case "checking_auth":
      return <Spinner label="Checking GitHub authentication..." />;

    case "auth_help":
      return (
        <Box flexDirection="column">
          <Text color="cyan">{WELCOME_ART}</Text>
          <WarningMessage>GitHub authentication not found.</WarningMessage>
          <Box marginTop={1} flexDirection="column">
            <Text>To authenticate with GitHub, you can:</Text>
            <Box marginTop={1} flexDirection="column">
              <Text color="gray">1. Use GitHub CLI (recommended):</Text>
              <Text color="cyan">   gh auth login</Text>
              <Box marginTop={1}>
                <Text color="gray">2. Set environment variable:</Text>
              </Box>
              <Text color="cyan">   export GITHUB_TOKEN=ghp_xxxx</Text>
            </Box>
          </Box>
          <Box marginTop={1}>
            <Text>Press </Text>
            <Text color="cyan">enter</Text>
            <Text> to continue (some features won't work)</Text>
          </Box>
        </Box>
      );

    case "select_merge_method":
      return (
        <Box flexDirection="column">
          <Text color="cyan">{WELCOME_ART}</Text>
          <Box marginBottom={1}>
            <Text bold>Select merge method</Text>
            <Text color="gray"> (how PRs get merged)</Text>
          </Box>
          <Text color="gray" dimColor>
            ↑↓ navigate  enter select
          </Text>
          <Box flexDirection="column" marginTop={1}>
            {MERGE_METHODS.map((method, index) => {
              const isSelected = index === wizardState.mergeMethodIndex;

              return (
                <Box key={method.value} flexDirection="column">
                  <Box>
                    <Text color={isSelected ? "cyan" : undefined}>
                      {isSelected ? "› " : "  "}
                    </Text>
                    <Text color={isSelected ? "cyan" : undefined} bold={isSelected}>
                      {method.label}
                    </Text>
                    <Text color="gray" dimColor>
                      {" "}
                      - {method.desc}
                    </Text>
                  </Box>
                </Box>
              );
            })}
          </Box>
        </Box>
      );

    case "auto_open_prompt":
      return (
        <Box flexDirection="column">
          <Text color="cyan">{WELCOME_ART}</Text>
          <Box flexDirection="column">
            <Text bold>Auto-open PRs in browser?</Text>
            <Text color="gray">After running `pile submit`, automatically open the PR in your browser.</Text>
            <Box marginTop={1}>
              <Text>Enable? </Text>
              <Text color="cyan">[y/N]</Text>
            </Box>
          </Box>
        </Box>
      );

    case "initializing":
      return <Spinner label="Initializing pile..." />;

    case "summary":
      return (
        <Box flexDirection="column">
          <Text color="green">{SUCCESS_ART}</Text>
          <Box flexDirection="column">
            <Text color="gray">Configuration:</Text>
            <Text>
              {"  "}Trunk branch: <Text color="cyan">{wizardState.selectedTrunk}</Text>
            </Text>
            <Text>
              {"  "}Merge method: <Text color="cyan">{wizardState.mergeMethod}</Text>
            </Text>
            <Text>
              {"  "}Auto-open PRs:{" "}
              <Text color={wizardState.autoOpenPR ? "green" : "gray"}>
                {wizardState.autoOpenPR ? "yes" : "no"}
              </Text>
            </Text>
            {wizardState.hasGitHubAuth && (
              <Text>
                {"  "}GitHub auth: <Text color="green">✓ {wizardState.authMethod}</Text>
              </Text>
            )}
          </Box>
          <Box marginTop={1} flexDirection="column">
            <Text bold>Next steps:</Text>
            <Text color="gray">  1. Create your first stacked branch:</Text>
            <Text color="cyan">     pile create -m "Your commit message"</Text>
            <Text color="gray">  2. Submit a PR:</Text>
            <Text color="cyan">     pile submit</Text>
            <Text color="gray">  3. View your stack:</Text>
            <Text color="cyan">     pile log</Text>
          </Box>
          <Box marginTop={1}>
            <Text color="gray" dimColor>
              Press enter to exit
            </Text>
          </Box>
        </Box>
      );

    case "already_initialized":
      return (
        <Box flexDirection="column">
          <InfoMessage>Pile already initialized</InfoMessage>
          <Box marginTop={1}>
            <Text>
              {"  "}Trunk branch: <Text color="cyan">{wizardState.selectedTrunk}</Text>
            </Text>
          </Box>
          <Box marginTop={1}>
            <Text color="gray" dimColor>
              Run `pile init --force` to reinitialize (coming soon)
            </Text>
          </Box>
        </Box>
      );

    case "error":
      return <ErrorMessage>{error}</ErrorMessage>;

    default:
      return <></>;
  }
}
