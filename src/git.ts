import * as vscode from "vscode";
import { execFile } from "child_process";
import * as fs from "fs";
import { promisify } from "util";
import * as path from "path";

const execFileAsync = promisify(execFile);

export interface CommitInfo {
  hash: string;
  subject: string;
  date: string;
  author: string;
  filePath: string; // path of the file at this commit (tracks renames)
}

/**
 * Resolve the git repository root for a file. We run git from the file's own
 * directory — not the workspace folder — so that nested repos, or a workspace
 * folder that merely contains several independent repos, still resolve to the
 * repo that actually tracks the file. The root is also the base git prints its
 * relative paths against, so it's what we join those back onto.
 */
export async function getRepoRoot(filePath: string): Promise<string | undefined> {
  try {
    const root = (
      await git(gitCwd(filePath), "rev-parse", "--show-toplevel")
    ).trim();
    return root || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The directory to run git from: the file's own, or the nearest ancestor that
 * still exists. A path taken from an older revision can name a directory a
 * later commit removed — a file moved out of a folder, say — and git refuses
 * to start in a working directory that isn't there.
 */
function gitCwd(filePath: string): string {
  let dir = path.dirname(filePath);
  while (!fs.existsSync(dir)) {
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return dir;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const config = vscode.workspace.getConfiguration("git");
  const gitPath = config.get<string>("path") || "git";
  const { stdout } = await execFileAsync(gitPath, args, {
    cwd,
    maxBuffer: 100 * 1024 * 1024,
  });
  return stdout;
}

/**
 * Get the list of commits that touched a file, newest first.
 * Tracks renames via --follow and --name-status.
 */
export async function getFileLog(filePath: string): Promise<CommitInfo[]> {
  const root = await getRepoRoot(filePath);
  if (!root) {
    return [];
  }
  const relativePath = path.relative(root, filePath).replace(/\\/g, "/");

  const output = (
    await git(
      root,
      "log",
      "--follow",
      "--name-status",
      "--format=%H%n%s%n%aI%n%an",
      "--",
      filePath
    )
  ).trim();
  if (!output) {
    return [];
  }

  const lines = output.split("\n");
  const commits: CommitInfo[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!lines[i]) {
      i++;
      continue;
    }
    const hash = lines[i];
    const subject = lines[i + 1] || "";
    const date = lines[i + 2] || "";
    const author = lines[i + 3] || "";
    i += 4;

    while (i < lines.length && lines[i] === "") {
      i++;
    }

    let commitFilePath = relativePath;
    if (i < lines.length && lines[i]) {
      const parts = lines[i].split("\t");
      const status = parts[0];
      if (status.startsWith("R") && parts.length >= 3) {
        commitFilePath = parts[2];
      } else if (parts.length >= 2) {
        commitFilePath = parts[1];
      }
      i++;
    }

    commits.push({
      hash,
      subject,
      date,
      author,
      filePath: path.join(root, commitFilePath),
    });
  }
  return commits;
}

/**
 * Get the list of files changed in a commit.
 */
export async function getChangedFiles(
  filePath: string,
  commitHash: string
): Promise<{ status: string; file: string }[]> {
  try {
    const output = (
      await git(
        gitCwd(filePath),
        "diff-tree",
        "--no-commit-id",
        "--name-status",
        "-r",
        commitHash
      )
    ).trim();
    if (!output) {
      return [];
    }
    return output.split("\n").map((line) => {
      const [status, ...rest] = line.split("\t");
      return { status, file: rest.join("\t") };
    });
  } catch {
    return [];
  }
}

export async function hasUncommittedChanges(
  filePath: string
): Promise<boolean> {
  try {
    const output = await git(
      gitCwd(filePath),
      "status",
      "--porcelain",
      "--",
      filePath
    );
    return output.trim().length > 0;
  } catch {
    return false;
  }
}

export async function getRemoteUrl(
  filePath: string
): Promise<string | undefined> {
  const root = await getRepoRoot(filePath);
  if (!root) {
    return undefined;
  }
  try {
    const raw = (await git(root, "remote", "get-url", "origin")).trim();
    if (!raw) {
      return undefined;
    }
    // Normalise SSH / scp-like remotes (git@host:owner/repo) and ssh:// URLs
    // to a browsable https base, then drop the trailing .git.
    const scp = raw.match(/^[^/@]+@([^:/]+):(.+)$/);
    const url = scp
      ? `https://${scp[1]}/${scp[2]}`
      : raw.replace(/^ssh:\/\/(?:[^/@]+@)?/, "https://");
    return url.replace(/\.git$/, "").replace(/\/+$/, "") || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Parse commit ref from a VS Code git-scheme URI.
 */
export function getCommitFromUri(uri: vscode.Uri): string | undefined {
  if (uri.scheme !== "git") {
    return undefined;
  }
  try {
    const query = JSON.parse(uri.query);
    return query.ref || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Get the real file path from a git-scheme or file-scheme URI.
 */
export function getRealPath(uri: vscode.Uri): string {
  if (uri.scheme === "git") {
    try {
      const query = JSON.parse(uri.query);
      if (query.path) {
        return query.path;
      }
    } catch {
      // ignore
    }
  }
  return uri.fsPath;
}
