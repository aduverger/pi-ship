import { readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type { ChangedFile, LineRange } from "./types.js";

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

export interface CommandOptions {
  cwd?: string;
  signal?: AbortSignal;
  timeout?: number;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options?: CommandOptions,
) => Promise<CommandResult>;

export async function git(
  runCommand: CommandRunner,
  cwd: string,
  args: string[],
  options: Omit<CommandOptions, "cwd"> = {},
): Promise<CommandResult> {
  return runCommand("git", args, { ...options, cwd });
}

export async function requireGit(
  runCommand: CommandRunner,
  cwd: string,
  args: string[],
  description = `git ${args.join(" ")}`,
): Promise<string> {
  const result = await git(runCommand, cwd, args);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
    throw new Error(`${description} failed in ${cwd}: ${detail}`);
  }
  return result.stdout.trim();
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function directGitRoots(runCommand: CommandRunner, workspaceRoot: string): Promise<string[]> {
  const entries = await readdir(workspaceRoot, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => resolve(workspaceRoot, entry.name));

  const roots = await Promise.all(
    candidates.map(async (candidate) => {
      if (!(await isDirectory(candidate))) return undefined;
      const result = await git(runCommand, candidate, ["rev-parse", "--show-toplevel"]);
      if (result.code !== 0) return undefined;
      const root = await realpath(result.stdout.trim());
      const directChild = await realpath(candidate);
      return root === directChild ? root : undefined;
    }),
  );

  return roots.filter((root): root is string => root !== undefined).sort();
}

function normalizeRequestedName(value: string): string {
  return value.replace(/^\.\//, "").replace(/\/$/, "");
}

export async function discoverRepositoryPaths(
  runCommand: CommandRunner,
  cwd: string,
  requested: readonly string[],
): Promise<{ root: string; repositories: string[]; workspace: boolean }> {
  const containing = await git(runCommand, cwd, ["rev-parse", "--show-toplevel"]);
  if (containing.code === 0) {
    if (requested.length > 0) {
      throw new Error("Repository names are only accepted when /ship is run from a workspace directory.");
    }
    const repository = await realpath(containing.stdout.trim());
    return { root: repository, repositories: [repository], workspace: false };
  }

  const workspaceRoot = await realpath(cwd);
  const repositories = await directGitRoots(runCommand, workspaceRoot);
  if (repositories.length === 0) throw new Error(`No direct child Git repositories found in ${workspaceRoot}.`);
  if (requested.length === 0) return { root: workspaceRoot, repositories, workspace: true };

  const byName = new Map(repositories.map((repository) => [basename(repository), repository]));
  const selected: string[] = [];
  for (const raw of requested) {
    const name = normalizeRequestedName(raw);
    let repository = byName.get(name);
    if (!repository) {
      const candidate = resolve(workspaceRoot, name);
      if (dirname(candidate) === workspaceRoot && repositories.includes(candidate)) repository = candidate;
    }
    if (!repository) {
      throw new Error(`Unknown workspace repository "${raw}". Available: ${[...byName.keys()].join(", ")}`);
    }
    if (!selected.includes(repository)) selected.push(repository);
  }

  return { root: workspaceRoot, repositories: selected, workspace: true };
}

export function parseGitHubRepository(remoteUrl: string): string {
  const trimmed = remoteUrl.trim().replace(/\.git$/, "");
  const scpMatch = trimmed.match(/^git@github\.com:([^/]+\/.+)$/);
  if (scpMatch?.[1]) return scpMatch[1];

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`Unsupported GitHub origin URL: ${remoteUrl}`);
  }
  if (url.hostname.toLowerCase() !== "github.com") {
    throw new Error(`Only github.com origins are supported in v1: ${remoteUrl}`);
  }
  const repository = url.pathname.replace(/^\//, "");
  if (repository.split("/").length !== 2) throw new Error(`Invalid GitHub repository URL: ${remoteUrl}`);
  return repository;
}

interface NameStatusEntry {
  status: string;
  path: string;
}

export function parseNameStatus(output: string): NameStatusEntry[] {
  const fields = output.split("\0");
  if (fields.at(-1) === "") fields.pop();
  const entries: NameStatusEntry[] = [];

  for (let index = 0; index < fields.length; ) {
    const status = fields[index++];
    if (!status) break;
    const kind = status[0];
    if (kind === "R" || kind === "C") {
      index += 1;
      const destination = fields[index++];
      if (destination) entries.push({ status, path: destination });
      continue;
    }
    const path = fields[index++];
    if (path) entries.push({ status, path });
  }

  return entries;
}

export function parseChangedLineRanges(diff: string): LineRange[] {
  const ranges: LineRange[] = [];
  const hunkPattern = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm;
  for (const match of diff.matchAll(hunkPattern)) {
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    if (count === 0) continue;
    ranges.push({ start, end: start + count - 1 });
  }
  return ranges;
}

function changedFileStatus(status: string): ChangedFile["status"] | undefined {
  switch (status[0]) {
    case "A":
      return "added";
    case "M":
      return "modified";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    default:
      return undefined;
  }
}

export async function collectChangedFiles(
  runCommand: CommandRunner,
  cwd: string,
  baseRef: string,
): Promise<ChangedFile[]> {
  const output = await requireGit(
    runCommand,
    cwd,
    ["diff", "--name-status", "-z", "--find-renames", `${baseRef}...HEAD`, "--"],
    "read changed files",
  );
  const entries = parseNameStatus(output);

  const files = await Promise.all(
    entries.map(async (entry): Promise<ChangedFile | undefined> => {
      const status = changedFileStatus(entry.status);
      if (!status) return undefined;
      if (status === "added") return { path: entry.path, status };

      const diff = await requireGit(
        runCommand,
        cwd,
        ["diff", "--no-ext-diff", "--no-color", "--unified=0", `${baseRef}...HEAD`, "--", entry.path],
        `read changed lines for ${entry.path}`,
      );
      const changedLines = parseChangedLineRanges(diff);
      return diff.includes("@@")
        ? { path: entry.path, status, changedLines }
        : { path: entry.path, status };
    }),
  );

  return files.filter((file): file is ChangedFile => file !== undefined);
}

export async function dirtyPaths(runCommand: CommandRunner, cwd: string): Promise<string[]> {
  const tracked = await requireGit(runCommand, cwd, ["diff", "--name-only", "-z", "HEAD", "--"]);
  const untracked = await requireGit(
    runCommand,
    cwd,
    ["ls-files", "--others", "--exclude-standard", "-z"],
  );
  return [...new Set(`${tracked}\0${untracked}`.split("\0").filter(Boolean))].sort();
}

export async function isClean(runCommand: CommandRunner, cwd: string): Promise<boolean> {
  const status = await requireGit(
    runCommand,
    cwd,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
  );
  return status.length === 0;
}

export async function hasChangesAgainstBase(
  runCommand: CommandRunner,
  cwd: string,
  baseRef: string,
): Promise<boolean> {
  const result = await git(runCommand, cwd, ["diff", "--quiet", `${baseRef}...HEAD`, "--"]);
  if (result.code === 0) return false;
  if (result.code === 1) return true;
  throw new Error(`Could not compare ${cwd} with ${baseRef}: ${result.stderr.trim()}`);
}
