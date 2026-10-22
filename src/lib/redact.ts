export const REDACTED = "[REDACTED]";

/** Common token shapes that must never reach the terminal even if not registered. */
const SECRET_PATTERNS: RegExp[] = [
  /\b(gh[pousr]_[A-Za-z0-9]{20,})\b/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g, // GitLab personal access tokens
  /\blin_api_[A-Za-z0-9]{20,}\b/g, // Linear API keys
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, // Authorization header values
];

/**
 * Removes known secret values and common token formats from text.
 * Registered secrets shorter than 4 characters are ignored to avoid mangling
 * ordinary output.
 */
export class Redactor {
  readonly #secrets = new Set<string>();

  register(secret: string | undefined): void {
    if (secret && secret.length >= 4) this.#secrets.add(secret);
  }

  redact(text: string): string {
    let out = text;
    // Replace longer secrets first so overlapping values are fully removed.
    for (const secret of [...this.#secrets].sort((a, b) => b.length - a.length)) {
      out = out.split(secret).join(REDACTED);
    }
    for (const pattern of SECRET_PATTERNS) {
      out = out.replace(pattern, (_match, scheme: unknown) =>
        typeof scheme === "string" && /^(bearer|basic)$/i.test(scheme)
          ? `${scheme} ${REDACTED}`
          : REDACTED,
      );
    }
    return out;
  }
}
