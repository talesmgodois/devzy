import type { AdapterContext, AdapterDefinition } from "../../adapter.ts";
import { type MockGitFixture, MockGitProvider, mockGitOptionsSchema } from "./mock-git.provider.ts";

/** Fictional GitHub contributors. Dana uses a GitHub noreply address. */
export const GITHUB_FIXTURE: MockGitFixture = {
  repositories: ["acme/api", "acme/web"],
  contributors: [
    {
      key: "asouza",
      ref: {
        displayName: "Ana Souza",
        email: "ana.souza@example.com",
        username: "asouza",
        providerUserId: "1001",
      },
      activity: 0.55,
      maxPerDay: 4,
      repositories: [0, 1],
    },
    {
      key: "bcarter",
      ref: {
        displayName: "Ben Carter",
        email: "ben.carter@example.com",
        username: "bcarter",
        providerUserId: "1002",
      },
      activity: 0.45,
      maxPerDay: 3,
      repositories: [0],
    },
    {
      key: "chenwei",
      ref: {
        displayName: "Chen Wei",
        email: "chen.wei@example.com",
        username: "chenwei",
        providerUserId: "1003",
      },
      activity: 0.35,
      maxPerDay: 5,
      repositories: [1],
    },
    {
      key: "samlee",
      ref: {
        displayName: "Sam Lee",
        email: "sam.lee@example.com",
        username: "samlee",
        providerUserId: "1004",
      },
      activity: 0.25,
      maxPerDay: 2,
      repositories: [0, 1],
    },
    {
      key: "dokafor",
      ref: {
        displayName: "Dana Okafor",
        email: "1005+dokafor@users.noreply.github.com",
        username: "dokafor",
        providerUserId: "1005",
      },
      activity: 0.4,
      maxPerDay: 3,
      repositories: [0],
    },
  ],
};

/** Mock GitHub adapter backed by {@link GITHUB_FIXTURE}. */
export class GitHubMockGitProvider extends MockGitProvider {
  constructor(id: string, name: string, options: unknown) {
    super(id, name, "github", options, GITHUB_FIXTURE);
  }
}

export const githubMockAdapter: AdapterDefinition = {
  mode: "mock",
  optionsSchema: mockGitOptionsSchema,
  setupFields: [],
  create: (ctx: AdapterContext) => new GitHubMockGitProvider(ctx.id, ctx.name, ctx.options),
};
