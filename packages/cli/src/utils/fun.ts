/**
 * Fun messages and easter eggs for pile
 *
 * Remember: pile can be a "pile of PRs" or a "pile of shit" -
 * the quality is up to you!
 */

// Random success messages for merges
const MERGE_SUCCESS_MESSAGES = [
  "Another one bites the dust",
  "That pile is now part of the foundation",
  "Successfully composted into main",
  "Pile integrated. Code smells: acceptable",
  "Your pile has ascended",
  "Merged! One less thing on the pile",
  "The pile grows smaller. You're winning",
  "Squashed and scattered to the winds",
  "Your code has joined the collective",
  "This pile? Chef's kiss",
];

// Messages when PR is approved
const APPROVAL_MESSAGES = [
  "This pile passes the smell test",
  "Certified fresh",
  "Ready to ship (no biohazard warning needed)",
  "Looking clean!",
  "Your pile has been blessed",
  "Approved! Not a dumpster fire",
];

// Messages when changes are requested
const CHANGES_REQUESTED_MESSAGES = [
  "This pile needs some work",
  "Back to the drawing board",
  "Almost there, but not quite",
  "Your pile requires attention",
  "Time for some cleanup",
];

// Messages when checks fail
const CHECKS_FAILED_MESSAGES = [
  "Your pile is on fire",
  "Houston, we have a problem",
  "The machines have spoken: nope",
  "CI says: try again",
  "Something's rotten in the state of your code",
];

// Messages when closing a PR without merging
const CLOSE_MESSAGES = [
  "Swept under the rug",
  "This pile has been dismissed",
  "Gone, but not forgotten",
  "Back to the void",
  "Closed! The pile shrinks",
  "This experiment has concluded",
];

// Messages when reopening a PR
const REOPEN_MESSAGES = [
  "Back from the dead!",
  "The pile returns",
  "You've given this another chance",
  "Resurrected!",
  "Like a phoenix from the ashes",
];

// Messages for Friday/weekend deploys
const FRIDAY_WARNINGS = [
  "It's Friday... are you sure about this?",
  "Weekend deploy detected. Bravery noted.",
  "TGIF? More like TGIM (Thank God It's Merged... hopefully)",
  "Friday merge? You're either brave or foolish. Probably both.",
  "Remember: the oncall person has feelings too",
];

// Messages when on trunk
const TRUNK_MESSAGES = [
  "You're at the bottom of the pile",
  "Starting fresh from the foundation",
  "The solid ground beneath all piles",
  "Home base",
];

// Messages when at top of stack
const TOP_OF_STACK_MESSAGES = [
  "You're king of this pile",
  "Top of the heap!",
  "The pinnacle of your stack",
  "Nowhere to go but... down?",
];

// Random motivational quotes for long rebases/restacks
const RESTACK_MESSAGES = [
  "Reorganizing the pile...",
  "Shuffling the stack...",
  "Making order from chaos...",
  "Tetris, but for code...",
  "Rebuilding the tower...",
];

// Messages for conflicts
const CONFLICT_MESSAGES = [
  "Your pile is conflicted (aren't we all?)",
  "Merge conflict! Time to play code mediator",
  "The branches disagree. You must choose",
  "Git needs couples therapy for these branches",
];

// Easter egg: pile wisdom
const PILE_WISDOM = [
  "A journey of a thousand PRs begins with a single commit",
  "In the pile, no one can hear you rebase",
  "To pile or not to pile, that is the question",
  "The pile is patient. The pile is kind. The pile does not judge your code (CI does)",
  "Behind every great codebase is a well-maintained pile",
  "A pile in time saves nine... reviews",
  "You miss 100% of the PRs you don't submit",
  "With great pile comes great responsibility",
  "The only constant in life is change... and merge conflicts",
  "Keep calm and restack on",
];

// Get random item from array
function random<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Check if it's Friday or weekend
function isFriday(): boolean {
  const day = new Date().getDay();
  return day === 5; // Friday
}

function isWeekend(): boolean {
  const day = new Date().getDay();
  return day === 0 || day === 6;
}

function isLateNight(): boolean {
  const hour = new Date().getHours();
  return hour >= 22 || hour < 6; // 10 PM to 6 AM
}

// Exported functions
export function getMergeSuccessMessage(): string {
  return random(MERGE_SUCCESS_MESSAGES);
}

export function getApprovalMessage(): string {
  return random(APPROVAL_MESSAGES);
}

export function getChangesRequestedMessage(): string {
  return random(CHANGES_REQUESTED_MESSAGES);
}

export function getChecksFailedMessage(): string {
  return random(CHECKS_FAILED_MESSAGES);
}

export function getCloseMessage(): string {
  return random(CLOSE_MESSAGES);
}

export function getReopenMessage(): string {
  return random(REOPEN_MESSAGES);
}

export function getTrunkMessage(): string {
  return random(TRUNK_MESSAGES);
}

export function getTopOfStackMessage(): string {
  return random(TOP_OF_STACK_MESSAGES);
}

export function getRestackMessage(): string {
  return random(RESTACK_MESSAGES);
}

export function getConflictMessage(): string {
  return random(CONFLICT_MESSAGES);
}

export function getPileWisdom(): string {
  return random(PILE_WISDOM);
}

/**
 * Get a warning message if deploying at a risky time
 * Returns null if it's a safe time to deploy
 */
export function getRiskyTimeWarning(): string | null {
  if (isFriday()) {
    return random(FRIDAY_WARNINGS);
  }
  if (isWeekend()) {
    return "Weekend warrior? Bold move. Proceed with caution.";
  }
  if (isLateNight()) {
    return "Late night coding session? Your future self sends regards.";
  }
  return null;
}

/**
 * Format PR status with fun flair (for human output only)
 */
export function formatStatusWithFlair(status: string): { text: string; subtext?: string } {
  switch (status) {
    case "approved":
      return { text: "Approved", subtext: getApprovalMessage() };
    case "changes_requested":
      return { text: "Changes Requested", subtext: getChangesRequestedMessage() };
    case "draft":
      return { text: "Draft", subtext: "Still cooking..." };
    case "merged":
      return { text: "Merged", subtext: "Mission accomplished" };
    case "closed":
      return { text: "Closed", subtext: "This pile has been archived" };
    default:
      return { text: "Open", subtext: "Awaiting judgment..." };
  }
}

/**
 * Get a message based on PR count
 */
export function getPileCountMessage(count: number): string {
  if (count === 0) {
    return "Your pile is empty. Time to write some code!";
  }
  if (count === 1) {
    return "Just one PR. Keeping it simple.";
  }
  if (count <= 3) {
    return "A nice, manageable pile";
  }
  if (count <= 5) {
    return "Your pile is growing...";
  }
  if (count <= 10) {
    return "That's quite a pile you've got there";
  }
  return "That's not a pile, that's a mountain!";
}

/**
 * Get emoji for PR status
 */
export function getStatusEmoji(status: string): string {
  switch (status) {
    case "approved":
      return "✨";
    case "changes_requested":
      return "🔧";
    case "draft":
      return "📝";
    case "merged":
      return "🎉";
    case "closed":
      return "🗃️";
    case "pending":
      return "⏳";
    default:
      return "👀";
  }
}

/**
 * Easter egg: secret pile command output
 */
export function getSecretPileMessage(): string {
  const wisdom = getPileWisdom();
  return `
    ╔════════════════════════════════════════════════╗
    ║            🗑️  THE PILE  🗑️                   ║
    ╠════════════════════════════════════════════════╣
    ║                                                ║
    ║   "Every masterpiece starts as                 ║
    ║    a pile of rough drafts"                     ║
    ║                                                ║
    ╚════════════════════════════════════════════════╝

    🥠 ${wisdom}

    You found the secret pile wisdom!

    Fun facts:
    • PRs merged today: You'll never know
    • Code quality: Schrödinger's pile
    • Estimated bugs: ¯\\_(ツ)_/¯

    Now get back to work! 🚀
`;
}
