import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  collectChangedFiles,
  discoverRepositoryPaths,
  parseChangedLineRanges,
  parseGitHubRepository,
  parseNameStatus,
  type CommandRunner,
} from "./git.js";

const execFileAsync = promisify(execFile);

const runCommand: CommandRunner = async (command, args, options) => {
  try {
    const result = await execFileAsync(command, args, {
      cwd: options?.cwd,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    return { stdout: result.stdout, stderr: result.stderr, code: 0, killed: false };
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? failure.message,
      code: typeof failure.code === "number" ? failure.code : 1,
      killed: false,
    };
  }
};

async function initRepository(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await execFileAsync("git", ["init", "-b", "main"], { cwd: path });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: path });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: path });
  await writeFile(join(path, "file.txt"), "one\ntwo\nthree\n", "utf8");
  await execFileAsync("git", ["add", "."], { cwd: path });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: path });
}

describe("parseGitHubRepository", () => {
  it.each([
    ["https://github.com/Emidat/emidat-api.git", "Emidat/emidat-api"],
    ["git@github.com:Emidat/emidat-api.git", "Emidat/emidat-api"],
    ["ssh://git@github.com/Emidat/emidat-api.git", "Emidat/emidat-api"],
  ])("parses %s", (url, expected) => {
    expect(parseGitHubRepository(url)).toBe(expected);
  });

  it("rejects non-GitHub origins", () => {
    expect(() => parseGitHubRepository("git@gitlab.com:group/repo.git")).toThrow("Unsupported GitHub origin URL");
  });
});

describe("Git diff parsing", () => {
  it("parses NUL-delimited names including renames", () => {
    expect(parseNameStatus("M\0a.ts\0R100\0old.ts\0new.ts\0D\0gone.ts\0")).toEqual([
      { status: "M", path: "a.ts" },
      { status: "R100", path: "new.ts" },
      { status: "D", path: "gone.ts" },
    ]);
  });

  it("uses current-file ranges and ignores deletion-only hunks", () => {
    const diff = ["@@ -2 +2,3 @@", "@@ -10,2 +12,0 @@", "@@ -20 +20 @@"].join("\n");
    expect(parseChangedLineRanges(diff)).toEqual([
      { start: 2, end: 4 },
      { start: 20, end: 20 },
    ]);
  });
});

describe("repository discovery", () => {
  it("discovers only direct child Git roots and supports subsets", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-ship-workspace-"));
    const first = join(workspace, "first");
    const second = join(workspace, "second");
    const nested = join(workspace, "container", "nested");
    await initRepository(first);
    await initRepository(second);
    await initRepository(nested);

    const canonicalWorkspace = await realpath(workspace);
    const canonicalFirst = join(canonicalWorkspace, "first");
    const canonicalSecond = join(canonicalWorkspace, "second");
    const all = await discoverRepositoryPaths(runCommand, workspace, []);
    expect(all.workspace).toBe(true);
    expect(all.repositories).toEqual([canonicalFirst, canonicalSecond]);

    const selected = await discoverRepositoryPaths(runCommand, workspace, ["second"]);
    expect(selected.repositories).toEqual([canonicalSecond]);

    const fromRepo = await discoverRepositoryPaths(runCommand, first, []);
    expect(fromRepo).toEqual({ root: canonicalFirst, repositories: [canonicalFirst], workspace: false });
  });
});

describe("collectChangedFiles", () => {
  it("reports added files and changed current line ranges", async () => {
    const repository = await mkdtemp(join(tmpdir(), "pi-ship-diff-"));
    await initRepository(repository);
    await execFileAsync("git", ["switch", "-c", "feature"], { cwd: repository });
    await writeFile(join(repository, "file.txt"), "one\nTWO\nthree\nfour\n", "utf8");
    await writeFile(join(repository, "added.txt"), "new\n", "utf8");
    await execFileAsync("git", ["add", "."], { cwd: repository });
    await execFileAsync("git", ["commit", "-m", "change"], { cwd: repository });

    const files = await collectChangedFiles(runCommand, repository, "refs/heads/main");
    expect(files).toEqual([
      { path: "added.txt", status: "added" },
      {
        path: "file.txt",
        status: "modified",
        changedLines: [
          { start: 2, end: 2 },
          { start: 4, end: 4 },
        ],
      },
    ]);
  });
});
