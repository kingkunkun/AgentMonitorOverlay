import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { removeTempDir } from "@amo-studio/testkit";
import { CLAUDE_PERMISSIONS, claudePermissionMode, codexPermission, codexPermissions, codexWindowsSandbox } from "./choices.js";

describe("Codex permissions", () => {
  it("maps each option to an approval policy and a sandbox, defaulting to ask-every-command", () => {
    expect(codexPermission(undefined)).toEqual({ approvalPolicy: "untrusted", sandbox: "danger-full-access", reviewer: "user" });
    expect(codexPermission("auto-review")).toEqual({ approvalPolicy: "on-request", sandbox: "workspace-write", reviewer: "auto_review" });
    expect(codexPermission("full-auto")).toEqual({ approvalPolicy: "never", sandbox: "danger-full-access", reviewer: "user" });
    expect(codexPermission("workspace-write")).toEqual({ approvalPolicy: "on-request", sandbox: "workspace-write", reviewer: "user" });
    expect(codexPermission("nonsense")).toEqual(codexPermission("ask"));
  });

  it("offers every option, noting the unelevated Windows sandbox", () => {
    const options = codexPermissions("unelevated");
    expect(options.some((p) => p.unavailable)).toBe(false);
    expect(options.find((p) => p.id === "workspace-write")!.description).toContain("unelevated");
  });

  it("reads [windows] sandbox from a Codex config", () => {
    const home = mkdtempSync(join(tmpdir(), "amo-studio-test-codexhome-"));
    try {
      expect(codexWindowsSandbox(home)).toBeNull();
      writeFileSync(join(home, "config.toml"), 'model = "x"\nsandbox = "not-this"\n[windows]\nsandbox = "unelevated"\n[tui]\nsandbox = "nor-this"\n');
      expect(codexWindowsSandbox(home)).toBe("unelevated");
    } finally {
      removeTempDir(home);
    }
  });
});

describe("Claude permissions", () => {
  it("offers Claude Code's modes and falls back to default", () => {
    expect(CLAUDE_PERMISSIONS.map((p) => p.id)).toEqual(["default", "auto", "acceptEdits", "plan", "bypassPermissions"]);
    expect(claudePermissionMode("plan")).toBe("plan");
    expect(claudePermissionMode(undefined)).toBe("default");
    expect(claudePermissionMode("auto")).toBe("auto");
    // Modes Studio does not offer fall back (dontAsk would deny what is not pre-approved, without a card).
    expect(claudePermissionMode("dontAsk")).toBe("default");
  });
});

// Every other test here runs with AMO_STUDIO_ASKING_DEFAULTS=1 (vitest.config.ts); people's Studio does not.
describe("defaults for people", () => {
  it("give a new chat full access when no permission is chosen (2026-11-23); unknown ids still ask", async () => {
    vi.stubEnv("AMO_STUDIO_ASKING_DEFAULTS", "");
    vi.resetModules();
    try {
      const c = await import("./choices.js");
      expect([c.CODEX_DEFAULT_PERMISSION, c.CLAUDE_DEFAULT_PERMISSION, c.DSH_DEFAULT_PERMISSION]).toEqual(["full-auto", "bypassPermissions", "full-access"]);
      expect(c.codexPermission(undefined)).toEqual({ approvalPolicy: "never", sandbox: "danger-full-access", reviewer: "user" });
      expect(c.codexPermission("nonsense")).toEqual(c.codexPermission("ask"));
      expect(c.claudePermissionMode(undefined)).toBe("bypassPermissions");
      expect(c.claudePermissionMode("dontAsk")).toBe("default");
      expect(c.dshPermissionMode(undefined)).toBe("danger-full-access");
      expect(c.dshPermissionMode("ask")).toBe("workspace-write");
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});

describe("withoutWindowsApps", () => {
  it("drops WindowsApps directories from PATH on Windows only", async () => {
    const { withoutWindowsApps } = await import("./codex/server-manager.js");
    const env = { Path: String.raw`C:\Program Files\WindowsApps\Microsoft.PowerShell_7\;C:\Windows\System32;C:\Users\me\AppData\Local\Microsoft\WindowsApps;E:\Python`, OTHER: "x" };
    expect(withoutWindowsApps(env, "win32")).toEqual({ Path: String.raw`C:\Windows\System32;E:\Python`, OTHER: "x" });
    expect(withoutWindowsApps(env, "linux")).toBe(env);
  });
});
