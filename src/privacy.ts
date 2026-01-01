import { createHash } from "node:crypto";

// src/privacy.ts — Privacy pre-scan + quarantine routing.
//
// STRICT default for v0.1: when a regex pattern hits, the chunk routes to the
// `quarantine` table instead of `session_chunks`/`memory_chunks`. Quarantined
// content is NEVER embedded — it never reaches Voyage's network.
//
// The operator periodically reviews quarantine; manually promotes false positives
// or leaves true positives excluded forever. Easier to add data than remove.

interface PrivacyPattern {
  reason: string;
  pattern: RegExp;
}

const PRIVACY_PATTERNS: PrivacyPattern[] = [
  // Private key blocks — highest signal, check first
  {
    reason: "private_key_block",
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/,
  },

  // 1Password references — never embed an op:// URI even if the path is "safe"
  { reason: "op_ref", pattern: /op:\/\/[A-Za-z0-9_-]+\/[A-Za-z0-9_./-]+/ },

  // Common API key shapes
  { reason: "anthropic_key", pattern: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { reason: "openai_key", pattern: /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/ },
  { reason: "supabase_secret", pattern: /sb_secret_[A-Za-z0-9_-]{20,}/ },
  { reason: "supabase_publishable", pattern: /sb_publishable_[A-Za-z0-9_-]{20,}/ },
  { reason: "github_token", pattern: /(?:gh[posur]_|github_pat_)[A-Za-z0-9_]{20,}/ },
  { reason: "voyage_key", pattern: /\bpa-[A-Za-z0-9_-]{40,}/ },
  { reason: "aws_access_key_id", pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/ },
  { reason: "stripe_key", pattern: /\b[rs]k_live_[A-Za-z0-9]{16,}/ },
  { reason: "slack_token", pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { reason: "npm_token", pattern: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { reason: "sendgrid_key", pattern: /SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/ },

  // Env-var-style secret assignments (KEY=value, SECRET=value, TOKEN=value)
  {
    reason: "env_var_secret",
    pattern:
      /\b[A-Z][A-Z0-9_]{2,}_(?:KEY|SECRET|TOKEN|PASSWORD|PWD)\s*[=:]\s*['"]?[A-Za-z0-9+/=_-]{16,}/,
  },

  // Bearer tokens
  { reason: "bearer_token", pattern: /Bearer\s+[A-Za-z0-9._-]{30,}/ },

  // Plaintext password assignments (quoted or unquoted)
  {
    reason: "password",
    pattern: /\b(?:password|pwd|passwd)\s*[:=]\s*['"][^'"]{6,}['"]/i,
  },
  {
    reason: "password_unquoted",
    pattern: /\b(?:password|passwd|pwd)\s*[:=]\s*[^\s'"]{8,}/i,
  },

  // JWT-shaped tokens (3 base64 segments separated by .)
  {
    reason: "jwt",
    pattern: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  },

  // Connection strings with embedded creds
  { reason: "postgres_url_with_creds", pattern: /postgres(?:ql)?:\/\/[^:\s]+:[^@\s]+@/ },
  {
    reason: "db_url_with_creds",
    pattern: /(?:mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^:\s]+:[^@\s]+@/,
  },

  // Sensitive .env / .secrets / op-token paths in tool args
  {
    reason: "env_path_read",
    pattern:
      /['"]?(?:\.env(?:\.[\w-]+)?|\.secrets\/[\w.-]+|op-service-account-token|master\.env)['"]?/,
  },
];

export interface PrivacyVerdict {
  pass: boolean;
  reason?: string;
  matchedPattern?: string;
}

/**
 * Scan content for sensitive patterns.
 * Returns the FIRST match — one hit is enough to quarantine.
 * The matched substring is truncated to 80 chars when reported, so we never
 * echo a full secret into the quarantine table.
 */
export function privacyPreScan(content: string): PrivacyVerdict {
  for (const { reason, pattern } of PRIVACY_PATTERNS) {
    const m = content.match(pattern);
    if (m) {
      return {
        pass: false,
        reason,
        matchedPattern: m[0].slice(0, 80),
      };
    }
  }
  return { pass: true };
}

/** Row shape for the `quarantine` table. */
export interface QuarantineRow {
  source_table: "session_chunks" | "memory_chunks";
  source_path: string;
  session_id: string | null;
  content: string;
  reason: string;
  matched_pattern: string;
  ingest_batch: string;
}

// Fingerprint salt — keeps the quarantine sha256 from being a confirmation
// oracle for a *guessed* low-entropy secret. Override per-deployment with a
// secret value (CB_FINGERPRINT_SALT, e.g. from 1Password) for true
// oracle-resistance; the committed default only defeats generic rainbow tables.
const FINGERPRINT_SALT =
  process.env.CB_FINGERPRINT_SALT ?? "corpus/quarantine/fingerprint/v1";

export function buildQuarantineRow(args: {
  source_table: "session_chunks" | "memory_chunks";
  source_path: string;
  session_id?: string | null;
  content: string;
  verdict: PrivacyVerdict;
  ingest_batch: string;
}): QuarantineRow {
  // Never store the raw chunk text or the full matched secret. Replace both with
  // a one-way SALTED fingerprint: sha256(salt + match) plus a tiny prefix and
  // length, enough to triage a false positive without echoing the secret.
  const reason = args.verdict.reason ?? "unknown";
  const match = args.verdict.matchedPattern ?? "";
  const sha256 = createHash("sha256").update(FINGERPRINT_SALT + match).digest("hex");
  const prefix = match.slice(0, 6);

  return {
    source_table: args.source_table,
    source_path: args.source_path,
    session_id: args.session_id ?? null,
    content: `[quarantined] reason=${reason} sha256=${sha256} prefix=${prefix} len=${match.length}`,
    reason,
    matched_pattern: match.slice(0, 8),
    ingest_batch: args.ingest_batch,
  };
}
