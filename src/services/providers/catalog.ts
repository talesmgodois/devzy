import type { ProviderCategory } from "../../domain/activity.ts";

/**
 * Provider types known to devzy, independent of whether an adapter exists.
 * Adapter availability (mock/live) is declared in registry.ts.
 */
export const PROVIDER_TYPES = {
  github: { category: "git", displayName: "GitHub" },
  gitlab: { category: "git", displayName: "GitLab" },
  bitbucket: { category: "git", displayName: "Bitbucket" },
  jira: { category: "tasks", displayName: "Jira" },
  linear: { category: "tasks", displayName: "Linear" },
  clickup: { category: "tasks", displayName: "ClickUp" },
  openproject: { category: "tasks", displayName: "OpenProject" },
} as const satisfies Record<string, { category: ProviderCategory; displayName: string }>;

export type ProviderTypeId = keyof typeof PROVIDER_TYPES;

export const PROVIDER_TYPE_IDS = Object.keys(PROVIDER_TYPES) as [
  ProviderTypeId,
  ...ProviderTypeId[],
];
