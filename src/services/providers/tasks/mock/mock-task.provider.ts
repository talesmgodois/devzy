import { z } from "zod";
import type { ContributorRef } from "../../../../domain/identity.ts";
import { daysInPeriod, formatCalendarDate } from "../../../../domain/period.ts";
import {
  type StatusMapping,
  summarizeTaskEvents,
  type TaskStatsResult,
  type VendorTaskEvent,
} from "../../../../domain/tasks.ts";
import type { HealthCheckable, HealthCheckResult } from "../../base.interface.ts";
import { assertNotFailing, mockBehaviourShape, mockHealthCheck } from "../../mock/mock-options.ts";
import { isWeekend, unitHash } from "../../mock/seed.ts";
import type { TaskProvider, TaskStatsQuery } from "../task.interface.ts";

export interface MockTaskContributor {
  key: string;
  ref: ContributorRef;
  /** Probability (0-1) of a status change on a given weekday. */
  activity: number;
}

export interface MockTaskFixture {
  contributors: readonly MockTaskContributor[];
  /** Vendor statuses to draw from; repeat entries to weight them. */
  statuses: readonly string[];
  statusMap: StatusMapping;
}

export const mockTaskOptionsSchema = z.strictObject({ ...mockBehaviourShape });

/** Maximum task status changes generated per contributor per day. */
const SLOTS_PER_DAY = 2;

/**
 * Deterministic fixture-backed task provider. Each generated event is a task
 * whose status last changed on that UTC day; vendor statuses are normalized
 * with the same shared rules a live adapter would use.
 */
export class MockTaskProvider implements TaskProvider, HealthCheckable {
  readonly category = "tasks";
  readonly mode = "mock";
  readonly #options: z.output<typeof mockTaskOptionsSchema>;

  constructor(
    readonly id: string,
    readonly name: string,
    readonly type: string,
    options: unknown,
    readonly fixture: MockTaskFixture,
  ) {
    this.#options = mockTaskOptionsSchema.parse(options ?? {});
  }

  async getUserTaskStats(query: TaskStatsQuery): Promise<TaskStatsResult> {
    assertNotFailing(this.#options.failReports, this.id);
    return summarizeTaskEvents(this.#events(query), this.fixture.statusMap);
  }

  healthCheck(signal: AbortSignal): Promise<HealthCheckResult> {
    return mockHealthCheck(this.#options.health, signal);
  }

  *#events(query: TaskStatsQuery): Generator<VendorTaskEvent> {
    const { statuses } = this.fixture;
    for (const day of daysInPeriod(query.period)) {
      const date = formatCalendarDate(day);
      for (const contributor of this.fixture.contributors) {
        const probability = isWeekend(day) ? contributor.activity * 0.1 : contributor.activity;
        for (let slot = 0; slot < SLOTS_PER_DAY; slot++) {
          const roll = unitHash(this.id, contributor.key, date, String(slot));
          if (roll >= probability) continue;
          const status = statuses[Math.floor((roll / probability) * statuses.length)];
          if (status === undefined) continue;
          yield { assignee: { ...contributor.ref }, assigneeKey: contributor.key, status };
        }
      }
    }
  }
}
