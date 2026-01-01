// src/scrub.ts — identity/topology scrubbing (config-driven denylist, boundary-matched).
//
// Replaces personal/infra topology with neutral placeholders so it never reaches
// an embedding, a vendor, or a published artifact. Denylist-based (NOT NER) —
// precise + auditable. The denylist is CONFIG-DRIVEN: only generic secret shapes
// (op:// refs) are built in; operator-specific terms (home-dir usernames, project
// refs, persona/family/client names) are SUPPLIED by the caller via ScrubTerms,
// loaded from an untracked scrub.config.ts (see scrub.config.ts.example). The
// public engine ships NO real identity terms — a scrubber that hardcodes its
// needles ships those needles.

/** Operator-specific terms the scrubber replaces. Loaded from scrub.config.ts. */
export interface ScrubTerms {
  /** Home-dir usernames: `/home/<user>` → $HOME, bare `<user>` token → <user>. */
  usernames?: string[];
  /** Supabase project refs (or any opaque infra id) → <project-ref>. */
  projectRefs?: string[];
  /** Persona / family / client names → <name>. */
  names?: string[];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replace identity/topology tokens with neutral placeholders.
 * Built-in: op:// secret refs (generic, always on). Caller-supplied via `terms`:
 * home-dir usernames, project refs, names. Boundary-matched so substrings of
 * larger words (e.g. a different user `/home/otheruser`) are not over-scrubbed.
 * Order matters: the home-path collapse runs before the standalone-username rule.
 */
export function identityScrub(text: string, terms: ScrubTerms = {}): string {
  let out = text.replace(/op:\/\/\S+/g, () => "<secret-ref>");

  for (const ref of terms.projectRefs ?? []) {
    if (ref) out = out.split(ref).join("<project-ref>");
  }
  for (const user of terms.usernames ?? []) {
    if (!user) continue;
    const u = escapeRegExp(user);
    // /home/<user> → $HOME, boundary-matched so /home/<user>x is left alone.
    out = out.replace(new RegExp(`/home/${u}(?=/|$)`, "g"), () => "$HOME");
    // standalone <user> token only (word boundary), not substrings.
    out = out.replace(new RegExp(`\\b${u}\\b`, "g"), () => "<user>");
  }
  for (const name of terms.names ?? []) {
    if (!name) continue;
    out = out.replace(new RegExp(`\\b${escapeRegExp(name)}\\b`, "g"), () => "<name>");
  }
  return out;
}
