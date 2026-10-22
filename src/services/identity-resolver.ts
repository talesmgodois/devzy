import {
  type ContributorRef,
  type IdentityMatch,
  normalizeEmail,
  type TeamMember,
} from "../domain/identity.ts";

export interface ResolvedIdentity {
  /**
   * Aggregation key. Rows with equal keys are combined:
   * - `member:<id>`            configured team member
   * - `email:<address>`        no team member; same normalized email
   * - `account:<provider>:<id>` / `user:<provider>:<login>` / `row:<provider>:<n>`
   *                            no email and no mapping; never merged across providers
   * - `ambiguous:<provider>:…` matched several members; kept separate
   */
  key: string;
  match: IdentityMatch;
  member: TeamMember | undefined;
  /** Team-member IDs that matched when `match` is `ambiguous`. */
  candidates: string[];
  /** Normalized emails known to belong to this contributor (used by --email). */
  emails: ReadonlySet<string>;
}

/**
 * Maps provider contributors to canonical team members.
 *
 * Matching order:
 * 1. Explicit account mapping (`identities[].accounts`) on provider instance
 *    ID plus `userId` (exact) or `username` (case-insensitive).
 * 2. Normalized email listed in `identities[].emails`.
 * If a step yields more than one member the contributor is `ambiguous` and is
 * not merged with anyone. Display names are never used.
 */
export class IdentityResolver {
  readonly #byAccountId = new Map<string, TeamMember[]>();
  readonly #byUsername = new Map<string, TeamMember[]>();
  readonly #byEmail = new Map<string, TeamMember[]>();
  #rowCounter = 0;

  constructor(members: readonly TeamMember[]) {
    for (const member of members) {
      for (const account of member.accounts) {
        if (account.userId !== undefined) {
          push(this.#byAccountId, `${account.provider}\u0000${account.userId}`, member);
        }
        if (account.username !== undefined) {
          push(
            this.#byUsername,
            `${account.provider}\u0000${account.username.toLowerCase()}`,
            member,
          );
        }
      }
      for (const email of member.emails) {
        const normalized = normalizeEmail(email);
        if (normalized) push(this.#byEmail, normalized, member);
      }
    }
  }

  resolve(providerId: string, ref: ContributorRef): ResolvedIdentity {
    const email = normalizeEmail(ref.email);
    const accountMatches = unique([
      ...(ref.providerUserId !== undefined
        ? (this.#byAccountId.get(`${providerId}\u0000${ref.providerUserId}`) ?? [])
        : []),
      ...(ref.username !== undefined
        ? (this.#byUsername.get(`${providerId}\u0000${ref.username.toLowerCase()}`) ?? [])
        : []),
    ]);
    const candidates =
      accountMatches.length > 0
        ? accountMatches
        : unique(email ? (this.#byEmail.get(email) ?? []) : []);

    if (candidates.length === 1) {
      const member = candidates[0] as TeamMember;
      const emails = new Set(member.emails.map((e) => normalizeEmail(e)).filter(isDefined));
      if (email) emails.add(email);
      return { key: `member:${member.id}`, match: "mapped", member, candidates: [], emails };
    }

    const accountKey = this.#accountKey(providerId, ref);
    const directEmails = new Set(email ? [email] : []);
    if (candidates.length > 1) {
      return {
        key: `ambiguous:${accountKey ?? (email ? `${providerId}:${email}` : this.#rowKey(providerId))}`,
        match: "ambiguous",
        member: undefined,
        candidates: candidates.map((m) => m.id).sort(),
        emails: directEmails,
      };
    }
    if (email) {
      return {
        key: `email:${email}`,
        match: "email",
        member: undefined,
        candidates: [],
        emails: directEmails,
      };
    }
    return {
      key: accountKey ?? `row:${this.#rowKey(providerId)}`,
      match: "unmapped",
      member: undefined,
      candidates: [],
      emails: directEmails,
    };
  }

  #accountKey(providerId: string, ref: ContributorRef): string | undefined {
    if (ref.providerUserId !== undefined) return `account:${providerId}:${ref.providerUserId}`;
    if (ref.username !== undefined) return `user:${providerId}:${ref.username.toLowerCase()}`;
    return undefined;
  }

  #rowKey(providerId: string): string {
    this.#rowCounter += 1;
    return `${providerId}:${this.#rowCounter}`;
  }
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
