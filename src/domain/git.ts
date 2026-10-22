import type { ContributorRef } from "./identity.ts";

/**
 * Commit activity for one contributor in one repository during a reporting
 * period. Providers return one row per (repository, contributor) pair; a
 * provider must not return the same pair twice. Aggregation sums rows, so
 * per-contributor totals across repositories are never double-counted.
 */
export interface GitCommitStats {
  repository: string;
  author: ContributorRef;
  /** Number of commits in the period. Always a positive integer. */
  commits: number;
}
