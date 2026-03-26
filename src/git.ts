import * as vscode from "vscode";
import { execFile } from "child_process";
import { promisify } from "util";
import * as path from "path";

const execFileAsync = promisify(execFile);

export interface CommitInfo {
  hash: string;
  subject: string;
  date: string;
}

function getWorkspaceFolder(filePath: string): string | undefined {
  const folder = vscode.workspace.getWorkspaceFolder(
    vscode.Uri.file(filePath)
  );
  return folder?.uri.fsPath;
}

async function git(
  cwd: string,
  ...args: string[]
): Promise<string> {
  const config = vscode.workspace.getConfiguration("git");
  const gitPath = config.get<string>("path") || "git";
  const { stdout } = await execFileAsync(gitPath, args, { cwd });
  return stdout.trim();
}

/**
 * Get the list of commits that touched a file, newest first.
 */
export async function getFileLog(
  filePath: string
): Promise<CommitInfo[]> {
  const cwd = getWorkspaceFolder(filePath);
  if (!cwd) {
    return [];
  }
  const output = await git(
    cwd,
    "log",
    "--follow",
    "--format=%H%n%s%n%aI",
    "--",
    filePath
  );
  if (!output) {
    return [];
  }
  const lines = output.split("\n");
  const commits: CommitInfo[] = [];
  for (let i = 0; i + 2 < lines.length; i += 3) {
    commits.push({
      hash: lines[i],
      subject: lines[i + 1],
      date: lines[i + 2],
    });
  }
  return commits;
}

/**
 * Get file content at a specific commit.
 */
export async function getFileAtCommit(
  filePath: string,
  commitHash: string
): Promise<string> {
  const cwd = getWorkspaceFolder(filePath);
  if (!cwd) {
    throw new Error("File is not in a workspace folder");
  }
  const relativePath = path.relative(cwd, filePath).replace(/\\/g, "/");
  return git(cwd, "show", `${commitHash}:${relativePath}`);
}

/**
 * Get the list of files changed in a commit.
 */
export async function getChangedFiles(
  filePath: string,
  commitHash: string
): Promise<{ status: string; file: string }[]> {
  const cwd = getWorkspaceFolder(filePath);
  if (!cwd) {
    return [];
  }
  const output = await git(
    cwd,
    "diff-tree",
    "--no-commit-id",
    "--name-status",
    "-r",
    commitHash
  );
  if (!output) {
    return [];
  }
  return output.split("\n").map((line) => {
    const [status, ...rest] = line.split("\t");
    return { status, file: rest.join("\t") };
  });
}

/**
 * Get the remote URL for the repository (for GitHub links).
 */
export async function getRemoteUrl(
  filePath: string
): Promise<string | undefined> {
  const cwd = getWorkspaceFolder(filePath);
  if (!cwd) {
    return undefined;
  }
  try {
    const url = await git(cwd, "remote", "get-url", "origin");
    // Convert SSH URLs to HTTPS
    return url
      .replace(/^git@github\.com:/, "https://github.com/")
      .replace(/\.git$/, "");
  } catch {
    return undefined;
  }
}

/**
 * Get the commit hash of the current revision being viewed in a diff,
 * parsed from a git-scheme URI.
 */
export function getCommitFromUri(uri: vscode.Uri): string | undefined {
  if (uri.scheme === "git") {
    try {
      const query = JSON.parse(uri.query);
      if (query.ref) {
        return query.ref;
      }
    } catch {
      // ignore
    }
  }
  return undefined;
}

/**
 * Get the real file path from a potentially git-scheme URI.
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
