import type { AdapterContext, AdapterDefinition } from "../../adapter.ts";
import { type MockGitFixture, MockGitProvider, mockGitOptionsSchema } from "./mock-git.provider.ts";

/** Fictional GitLab contributors. Ana commits with a personal address here. */
export const GITLAB_FIXTURE: MockGitFixture = {
  repositories: ["acme/infra", "acme/mobile"],
  contributors: [
    {
      key: "ana.souza",
      ref: {
        displayName: "Ana Souza",
        email: "ana@personal.example",
        username: "ana.souza",
        providerUserId: "2001",
      },
      activity: 0.3,
      maxPerDay: 2,
      repositories: [0],
    },
    {
      key: "ben.carter",
      ref: {
        displayName: "Ben Carter",
        email: "Ben.Carter@Example.com",
        username: "ben.carter",
        providerUserId: "2002",
      },
      activity: 0.35,
      maxPerDay: 3,
      repositories: [0, 1],
    },
    {
      key: "fhaddad",
      ref: {
        displayName: "Farah Haddad",
        email: "farah.haddad@example.com",
        username: "fhaddad",
        providerUserId: "2003",
      },
      activity: 0.5,
      maxPerDay: 4,
      repositories: [1],
    },
    {
      key: "build-bot",
      ref: { displayName: "Release Bot", username: "release-bot", providerUserId: "2099" },
      activity: 0.2,
      maxPerDay: 1,
      repositories: [0, 1],
    },
  ],
};

/** Mock GitLab adapter backed by {@link GITLAB_FIXTURE}. */
export class GitLabMockGitProvider extends MockGitProvider {
  constructor(id: string, name: string, options: unknown) {
    super(id, name, "gitlab", options, GITLAB_FIXTURE);
  }
}

export const gitlabMockAdapter: AdapterDefinition = {
  mode: "mock",
  optionsSchema: mockGitOptionsSchema,
  setupFields: [],
  create: (ctx: AdapterContext) => new GitLabMockGitProvider(ctx.id, ctx.name, ctx.options),
};
