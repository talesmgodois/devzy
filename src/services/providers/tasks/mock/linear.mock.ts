import type { AdapterContext, AdapterDefinition } from "../../adapter.ts";
import { LINEAR_STATUS_MAP } from "../status-maps.ts";
import {
  type MockTaskFixture,
  MockTaskProvider,
  mockTaskOptionsSchema,
} from "./mock-task.provider.ts";

/** Fictional Linear users. */
export const LINEAR_FIXTURE: MockTaskFixture = {
  contributors: [
    {
      key: "chen",
      ref: {
        displayName: "Chen Wei",
        email: "chen.wei@example.com",
        providerUserId: "lin_usr_chen",
      },
      activity: 0.5,
    },
    {
      key: "farah",
      ref: {
        displayName: "Farah Haddad",
        email: "farah.haddad@example.com",
        providerUserId: "lin_usr_farah",
      },
      activity: 0.45,
    },
    {
      key: "grace",
      ref: {
        displayName: "Grace Kim",
        email: "grace.kim@example.com",
        providerUserId: "lin_usr_grace",
      },
      activity: 0.35,
    },
    {
      key: "ana",
      ref: {
        displayName: "Ana S.",
        email: "ANA.SOUZA@example.com ",
        providerUserId: "lin_usr_ana",
      },
      activity: 0.2,
    },
  ],
  statuses: ["Done", "Done", "In Progress", "In Progress", "In Review", "Canceled"],
  statusMap: LINEAR_STATUS_MAP,
};

/** Mock Linear adapter backed by {@link LINEAR_FIXTURE}. */
export class LinearMockTaskProvider extends MockTaskProvider {
  constructor(id: string, name: string, options: unknown) {
    super(id, name, "linear", options, LINEAR_FIXTURE);
  }
}

export const linearMockAdapter: AdapterDefinition = {
  mode: "mock",
  optionsSchema: mockTaskOptionsSchema,
  setupFields: [],
  create: (ctx: AdapterContext) => new LinearMockTaskProvider(ctx.id, ctx.name, ctx.options),
};
