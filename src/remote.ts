const PART = "[A-Za-z0-9_.-]+";
const PATTERNS = [
  new RegExp(`^git@github\\.com:(${PART})/(${PART})$`),
  new RegExp(`^(?:https?|ssh|git)://(?:[^@/]+@)?github\\.com/(${PART})/(${PART})$`),
  // Bare owner/repo: GitHub owners are alphanumeric and hyphenated only.
  new RegExp(`^([A-Za-z0-9-]+)/(${PART})$`),
];

export function normalizeRemote(input: string): { owner: string; repo: string } | null {
  const s = input.trim().replace(/\/+$/, "").replace(/\.git$/, "");
  for (const re of PATTERNS) {
    const m = re.exec(s);
    if (!m || !m[1] || !m[2] || m[2] === "." || m[2] === "..") continue;
    return { owner: m[1].toLowerCase(), repo: m[2].toLowerCase() };
  }
  return null;
}
