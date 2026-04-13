import * as vscode from "vscode";
import { execFile } from "child_process";
import { promisify } from "util";
import * as path from "path";

const execFileAsync = promisify(execFile);

export interface CommitInfo {
  hash: string;
  subject: string;
  date: string;
  filePath: string; // path of the file at this commit (tracks renames)
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
  const relativePath = path.relative(cwd, filePath).replace(/\\/g, "/");

  // Use --name-status and --follow to track renames
  const output = await git(
    cwd,
    "log",
    "--follow",
    "--name-status",
    "--format=%H%n%s%n%aI",
    "--",
    filePath
  );
  if (!output) {
    return [];
  }
  const lines = output.split("\n");
  const commits: CommitInfo[] = [];
  let i = 0;
  while (i < lines.length) {
    // Skip empty lines
    if (!lines[i]) {
      i++;
      continue;
    }
    const hash = lines[i];
    const subject = lines[i + 1] || "";
    const date = lines[i + 2] || "";
    i += 3;

    // Skip empty lines between header and name-status
    while (i < lines.length && lines[i] === "") {
      i++;
    }

    // Parse name-status line (e.g. "M\tfile.txt" or "R100\told.txt\tnew.txt")
    let commitFilePath = relativePath;
    if (i < lines.length && lines[i]) {
      const parts = lines[i].split("\t");
      const status = parts[0];
      if (status.startsWith("R") && parts.length >= 3) {
        // Rename: old path is parts[1]
        commitFilePath = parts[1];
      } else if (parts.length >= 2) {
        commitFilePath = parts[1];
      }
      i++;
    }

    commits.push({
      hash,
      subject,
      date,
      filePath: path.join(cwd, commitFilePath),
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
 * Check whether the file has uncommitted changes (staged or unstaged).
 */
export async function hasUncommittedChanges(
  filePath: string
): Promise<boolean> {
  const cwd = getWorkspaceFolder(filePath);
  if (!cwd) {
    return false;
  }
  try {
    const output = await git(cwd, "status", "--porcelain", "--", filePath);
    return output.length > 0;
  } catch {
    return false;
  }
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
