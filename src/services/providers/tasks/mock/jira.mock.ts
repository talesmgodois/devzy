import type { AdapterContext, AdapterDefinition } from "../../adapter.ts";
import { JIRA_STATUS_MAP } from "../status-maps.ts";
import {
  type MockTaskFixture,
  MockTaskProvider,
  mockTaskOptionsSchema,
} from "./mock-task.provider.ts";

/**
 * Fictional Jira users. Dana and Ivo hide their email (Jira privacy settings),
 * and this Sam Lee is a different person from the GitHub Sam Lee.
 */
export const JIRA_FIXTURE: MockTaskFixture = {
  contributors: [
    {
      key: "ana",
      ref: {
        displayName: "Ana Souza",
        email: "ana.souza@example.com",
        providerUserId: "712020:ana",
      },
      activity: 0.45,
    },
    {
      key: "ben",
      ref: {
        displayName: "Ben Carter",
        email: "ben.carter@example.com",
        providerUserId: "712020:ben",
      },
      activity: 0.4,
    },
    {
      key: "dana",
      ref: { displayName: "Dana Okafor", providerUserId: "712020:dana" },
      activity: 0.5,
    },
    {
      key: "sam",
      ref: { displayName: "Sam Lee", email: "sam.lee@example.org", providerUserId: "712020:saml" },
      activity: 0.3,
    },
    {
      key: "ivo",
      ref: { displayName: "Ivo Petrov", providerUserId: "712020:ivo" },
      activity: 0.25,
    },
  ],
  statuses: [
    "Done",
    "Done",
    "Done",
    "Closed",
    "In Progress",
    "In Progress",
    "In Review",
    "QA",
    "Blocked",
  ],
  statusMap: JIRA_STATUS_MAP,
};

/** Mock Jira adapter backed by {@link JIRA_FIXTURE}. */
export class JiraMockTaskProvider extends MockTaskProvider {
  constructor(id: string, name: string, options: unknown) {
    super(id, name, "jira", options, JIRA_FIXTURE);
  }
}

export const jiraMockAdapter: AdapterDefinition = {
  mode: "mock",
  optionsSchema: mockTaskOptionsSchema,
  setupFields: [],
  create: (ctx: AdapterContext) => new JiraMockTaskProvider(ctx.id, ctx.name, ctx.options),
};
