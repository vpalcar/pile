/** Longest slug after the `mm-dd-` date prefix. */
const MAX_SLUG = 40;

/**
 * A branch name from a commit message: `mm-dd-slug-from-message`. Long messages are cut
 * at the last whole word that fits, never mid-word.
 */
export function deriveBranchName(message: string, now = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");

  let slug = message
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "") // Remove special chars
    .trim()
    .replace(/\s+/g, "-") // Replace spaces with dashes
    .replace(/-+/g, "-") // Replace multiple dashes with single
    .replace(/^-|-$/g, ""); // Remove leading/trailing dashes

  if (slug.length > MAX_SLUG) {
    // One character more, so a word ending exactly at the limit is kept.
    const cut = slug.slice(0, MAX_SLUG + 1);
    const lastDash = cut.lastIndexOf("-");
    // A single word longer than the limit has no boundary to cut at.
    slug = lastDash > 0 ? cut.slice(0, lastDash) : slug.slice(0, MAX_SLUG);
  }

  return `${month}-${day}-${slug}`;
}
