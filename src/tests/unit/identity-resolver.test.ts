import { describe, expect, test } from "bun:test";
import { normalizeEmail, type TeamMember } from "../../domain/identity.ts";
import { IdentityResolver } from "../../services/identity-resolver.ts";

const members: TeamMember[] = [
  {
    id: "ana",
    name: "Ana Souza",
    emails: ["ana.souza@example.com", "ana@personal.example"],
    accounts: [{ provider: "jira-main", userId: "acc-ana" }],
  },
  {
    id: "dana",
    name: "Dana Okafor",
    emails: [],
    accounts: [{ provider: "gh", username: "DOkafor" }],
  },
];

describe("normalizeEmail", () => {
  test("trims and lowercases, keeps dots and plus tags", () => {
    expect(normalizeEmail("  First.Last+tag@Example.COM ")).toBe("first.last+tag@example.com");
    expect(normalizeEmail("   ")).toBeUndefined();
    expect(normalizeEmail(undefined)).toBeUndefined();
  });
});

describe("IdentityResolver", () => {
  const resolver = () => new IdentityResolver(members);

  test("maps by account ID", () => {
    const r = resolver().resolve("jira-main", {
      displayName: "Someone Else",
      providerUserId: "acc-ana",
    });
    expect(r.match).toBe("mapped");
    expect(r.key).toBe("member:ana");
    expect([...r.emails].sort()).toEqual(["ana.souza@example.com", "ana@personal.example"]);
  });

  test("account mapping is scoped to the provider instance", () => {
    const r = resolver().resolve("jira-other", {
      displayName: "Ana Souza",
      providerUserId: "acc-ana",
    });
    expect(r.match).toBe("unmapped");
    expect(r.key).toBe("account:jira-other:acc-ana");
  });

  test("maps by username case-insensitively", () => {
    expect(resolver().resolve("gh", { displayName: "D", username: "dokafor" }).key).toBe(
      "member:dana",
    );
  });

  test("maps aliases (secondary emails), case and whitespace insensitive", () => {
    const r = resolver().resolve("gitlab", { displayName: "A", email: " ANA@Personal.Example" });
    expect(r.key).toBe("member:ana");
  });

  test("never matches by display name", () => {
    const r = resolver().resolve("gitlab", {
      displayName: "Ana Souza",
      email: "someone@example.com",
    });
    expect(r.match).toBe("email");
    expect(r.key).toBe("email:someone@example.com");
  });

  test("duplicate display names with different emails stay separate", () => {
    const res = resolver();
    const a = res.resolve("gh", { displayName: "Sam Lee", email: "sam.lee@example.com" });
    const b = res.resolve("jira-main", { displayName: "Sam Lee", email: "sam.lee@example.org" });
    expect(a.key).not.toBe(b.key);
  });

  test("same unmapped email across providers combines (documented rule)", () => {
    const res = resolver();
    const a = res.resolve("gh", { displayName: "Ben", email: "ben@example.com" });
    const b = res.resolve("gitlab", { displayName: "Benjamin", email: "BEN@example.com" });
    expect(a.key).toBe(b.key);
    expect(a.match).toBe("email");
  });

  test("missing email and no mapping: unmapped, kept per provider account, no email data", () => {
    const res = resolver();
    const a = res.resolve("jira-main", { displayName: "Ivo", providerUserId: "acc-ivo" });
    const b = res.resolve("linear", { displayName: "Ivo", providerUserId: "acc-ivo" });
    expect(a.match).toBe("unmapped");
    expect(a.key).not.toBe(b.key);
    expect(a.emails.size).toBe(0);
  });

  test("rows without any identifier never merge with each other", () => {
    const res = resolver();
    const a = res.resolve("gh", { displayName: "Unknown" });
    const b = res.resolve("gh", { displayName: "Unknown" });
    expect(a.key).not.toBe(b.key);
  });

  test("ambiguous email (listed for two members) is kept separate and not guessed", () => {
    const res = new IdentityResolver([
      { id: "a", name: "A", emails: ["shared@example.com"], accounts: [] },
      { id: "b", name: "B", emails: ["shared@example.com"], accounts: [] },
    ]);
    const r = res.resolve("gh", {
      displayName: "Shared",
      email: "shared@example.com",
      providerUserId: "9",
    });
    expect(r.match).toBe("ambiguous");
    expect(r.candidates).toEqual(["a", "b"]);
    expect(r.key).toBe("ambiguous:account:gh:9");
    expect(r.member).toBeUndefined();
  });

  test("explicit account mapping takes precedence over email", () => {
    const res = new IdentityResolver([
      { id: "a", name: "A", emails: ["x@example.com"], accounts: [] },
      { id: "b", name: "B", emails: [], accounts: [{ provider: "gh", userId: "7" }] },
    ]);
    expect(
      res.resolve("gh", { displayName: "X", email: "x@example.com", providerUserId: "7" }).key,
    ).toBe("member:b");
  });
});
