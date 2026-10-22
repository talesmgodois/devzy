/**
 * Provider-independent contributor identity model.
 *
 * Providers report contributors as {@link ContributorRef}s that carry whatever
 * identifiers the vendor exposes. Identity resolution (see
 * services/identity-resolver.ts) maps them to canonical team members using
 * explicit configuration. Display names are never used for matching.
 */

/** A contributor as seen by one provider, before identity resolution. */
export interface ContributorRef {
  /** Human-readable name. Display only; never used for matching. */
  displayName: string;
  /** Email address as supplied by the provider, if any. */
  email?: string | undefined;
  /** Stable provider account ID (e.g. GitHub numeric user ID, Jira accountId). */
  providerUserId?: string | undefined;
  /** Provider login/username (e.g. GitHub login). */
  username?: string | undefined;
}

/** A provider account linked explicitly to a canonical team member. */
export interface IdentityAccount {
  /** Configured provider instance ID. */
  provider: string;
  userId?: string | undefined;
  username?: string | undefined;
}

/** A canonical team member from configuration. */
export interface TeamMember {
  id: string;
  name: string;
  emails: string[];
  accounts: IdentityAccount[];
}

/**
 * How a contributor row was attributed:
 * - `mapped`: linked to a configured team member (by account or email).
 * - `email`: no team member, but rows with the same normalized email were combined.
 * - `unmapped`: no email and no mapping; kept separate per provider account.
 * - `ambiguous`: matched more than one team member; kept separate, never guessed.
 */
export type IdentityMatch = "mapped" | "email" | "unmapped" | "ambiguous";

/**
 * Normalizes an email for comparison: trims surrounding whitespace and
 * lowercases the whole address. No provider-specific rewriting (such as
 * removing dots or `+tags`) is performed. Returns undefined for blank input.
 */
export function normalizeEmail(email: string | undefined | null): string | undefined {
  if (email === undefined || email === null) return undefined;
  const normalized = email.trim().toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
}

/** Permissive syntax check: exactly one `@` with non-empty parts and no whitespace. */
export function isPlausibleEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+$/.test(email.trim());
}
