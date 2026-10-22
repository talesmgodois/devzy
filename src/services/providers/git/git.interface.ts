import type { GitCommitStats } from "../../../domain/git.ts";
import type { ReportingPeriod } from "../../../domain/period.ts";
import type { BaseProvider } from "../base.interface.ts";

export interface GitStatsQuery {
  period: ReportingPeriod;
  /**
   * Lowercased `owner/name` values. When non-empty the provider should only
   * query these repositories (intersected with its configured scope). The
   * aggregation service re-applies the filter locally, so pushing it down is
   * an optimisation, not a correctness requirement.
   */
  repositories: readonly string[];
  signal?: AbortSignal | undefined;
}

export interface GitProvider extends BaseProvider {
  readonly category: "git";
  /** Returns one row per (repository, contributor) with commits in the period. */
  getCommitStats(query: GitStatsQuery): Promise<GitCommitStats[]>;
}
