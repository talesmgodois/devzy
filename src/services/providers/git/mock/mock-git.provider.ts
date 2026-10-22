import { z } from "zod";
import type { GitCommitStats } from "../../../../domain/git.ts";
import type { ContributorRef } from "../../../../domain/identity.ts";
import { daysInPeriod, formatCalendarDate } from "../../../../domain/period.ts";
import type { HealthCheckable, HealthCheckResult } from "../../base.interface.ts";
import { assertNotFailing, mockBehaviourShape, mockHealthCheck } from "../../mock/mock-options.ts";
import { isWeekend, unitHash } from "../../mock/seed.ts";
import type { GitProvider, GitStatsQuery } from "../git.interface.ts";

export interface MockGitContributor {
  /** Fixture-unique key used for seeding. */
  key: string;
  ref: ContributorRef;
  /** Probability (0-1) of committing to a given repository on a weekday. */
  activity: number;
  /** Maximum commits on an active day. */
  maxPerDay: number;
  /** Fixture repositories this contributor works in (indices into `repositories`). */
  repositories: readonly number[];
}

export interface MockGitFixture {
  repositories: readonly string[];
  contributors: readonly MockGitContributor[];
}

const REPO_RE = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)+$/;

export const mockGitOptionsSchema = z.strictObject({
  ...mockBehaviourShape,
  /**
   * Overrides the fixture repository names. Every fixture contributor is then
   * active in every listed repository.
   */
  repositories: z
    .array(z.string().regex(REPO_RE, { error: "must be owner/name" }))
    .min(1, { error: "must list at least one repository" })
    .optional(),
});

/**
 * Deterministic fixture-backed Git provider.
 *
 * Commits are generated per UTC calendar day from a hash of
 * (provider ID, repository, contributor, date). The same inputs always produce
 * the same output, a period's totals equal the sum of its sub-periods, and
 * nothing is generated outside the requested period.
 */
export class MockGitProvider implements GitProvider, HealthCheckable {
  readonly category = "git";
  readonly mode = "mock";
  readonly #options: z.output<typeof mockGitOptionsSchema>;

  constructor(
    readonly id: string,
    readonly name: string,
    readonly type: string,
    options: unknown,
    readonly fixture: MockGitFixture,
  ) {
    this.#options = mockGitOptionsSchema.parse(options ?? {});
  }

  async getCommitStats(query: GitStatsQuery): Promise<GitCommitStats[]> {
    assertNotFailing(this.#options.failReports, this.id);
    const assignments = this.#assignments().filter(
      ({ repository }) =>
        query.repositories.length === 0 || query.repositories.includes(repository.toLowerCase()),
    );
    const days = [...daysInPeriod(query.period)];
    const rows: GitCommitStats[] = [];
    for (const { repository, contributor } of assignments) {
      let commits = 0;
      for (const day of days) {
        const roll = unitHash(this.id, repository, contributor.key, formatCalendarDate(day));
        const probability = isWeekend(day) ? contributor.activity * 0.15 : contributor.activity;
        if (roll < probability) {
          // Reuse the roll's position inside the active band to pick a count.
          commits += 1 + Math.floor((roll / probability) * contributor.maxPerDay);
        }
      }
      if (commits > 0) rows.push({ repository, author: { ...contributor.ref }, commits });
    }
    return rows;
  }

  healthCheck(signal: AbortSignal): Promise<HealthCheckResult> {
    return mockHealthCheck(this.#options.health, signal);
  }

  #assignments(): { repository: string; contributor: MockGitContributor }[] {
    const override = this.#options.repositories;
    const out: { repository: string; contributor: MockGitContributor }[] = [];
    if (override) {
      for (const repository of override) {
        for (const contributor of this.fixture.contributors) out.push({ repository, contributor });
      }
      return out;
    }
    this.fixture.repositories.forEach((repository, index) => {
      for (const contributor of this.fixture.contributors) {
        if (contributor.repositories.includes(index)) out.push({ repository, contributor });
      }
    });
    return out;
  }
}
