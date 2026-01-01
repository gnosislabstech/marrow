// src/analytics/project-path.ts — canonicalize project_path for analytics rollups.
//
// Folds worktrees / scratch / bare-home paths into their logical project and
// buckets the unscoped catch-alls, so project-attention analytics don't fragment
// one repo across many path spellings.

import { homedir } from "node:os";

export const UNSCOPED = "unscoped";

/**
 * Map a raw sessions.project_path to its canonical logical project.
 * NULL / bare-home / scratch → UNSCOPED. Worktrees fold to their parent repo.
 */
export function canonicalizeProjectPath(projectPath: string | null | undefined): string {
  if (projectPath == null) return UNSCOPED;

  // Bare home + any scratch path carry no project signal.
  if (projectPath === homedir()) return UNSCOPED;
  if (projectPath === "/tmp" || projectPath.startsWith("/tmp/")) return UNSCOPED;

  // Worktrees fold to the parent repo: drop any `.<name>-worktrees/<id>` segment
  // and everything below it.
  const wt = projectPath.search(/\/\.[^/]+-worktrees\//);
  if (wt !== -1) return projectPath.slice(0, wt);

  return projectPath;
}
