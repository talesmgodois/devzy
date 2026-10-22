import type { ConfigFile } from "./schema.ts";

/**
 * Configuration used only when no configuration file exists, so a fresh
 * installation can run every command. All providers are mock providers.
 */
export const BUILT_IN_DEMO_CONFIG: ConfigFile = {
  version: 1,
  providers: [
    {
      id: "github-demo",
      type: "github",
      name: "GitHub (demo)",
      enabled: true,
      mode: "mock",
      options: {},
    },
    {
      id: "gitlab-demo",
      type: "gitlab",
      name: "GitLab (demo)",
      enabled: true,
      mode: "mock",
      options: {},
    },
    {
      id: "jira-demo",
      type: "jira",
      name: "Jira (demo)",
      enabled: true,
      mode: "mock",
      options: {},
    },
    {
      id: "linear-demo",
      type: "linear",
      name: "Linear (demo)",
      enabled: true,
      mode: "mock",
      options: {},
    },
  ],
  identities: [
    {
      id: "ana",
      name: "Ana Souza",
      emails: ["ana.souza@example.com", "ana@personal.example"],
      accounts: [],
    },
    {
      id: "dana",
      name: "Dana Okafor",
      emails: ["dana.okafor@example.com"],
      accounts: [
        { provider: "github-demo", userId: "1005" },
        { provider: "jira-demo", userId: "712020:dana" },
      ],
    },
  ],
};
