import * as vscode from "vscode";
import {
  getFileLog,
  getCommitFromUri,
  getRealPath,
  CommitInfo,
} from "./git";

let currentCommits: CommitInfo[] = [];
let currentIndex = -1;
let currentFilePath = "";

async function updateContext(editor: vscode.TextEditor | undefined) {
  if (!editor) {
    currentCommits = [];
    currentIndex = -1;
    currentFilePath = "";
    await vscode.commands.executeCommand(
      "setContext",
      "prevNextRevision.canNavigate",
      false
    );
    return;
  }

  const uri = editor.document.uri;

  // Only work with file and git scheme URIs
  if (uri.scheme !== "file" && uri.scheme !== "git") {
    currentCommits = [];
    currentIndex = -1;
    currentFilePath = "";
    await vscode.commands.executeCommand(
      "setContext",
      "prevNextRevision.canNavigate",
      false
    );
    return;
  }

  const filePath = getRealPath(uri);

  try {
    const commits = await getFileLog(filePath);
    if (commits.length === 0) {
      currentCommits = [];
      currentIndex = -1;
      currentFilePath = "";
      await vscode.commands.executeCommand(
        "setContext",
        "prevNextRevision.canNavigate",
        false
      );
      return;
    }

    currentCommits = commits;
    currentFilePath = filePath;

    // Determine current index based on commit hash from URI
    const commitHash = getCommitFromUri(uri);
    if (commitHash) {
      currentIndex = commits.findIndex((c) =>
        c.hash.startsWith(commitHash)
      );
      if (currentIndex === -1) {
        // Commit not found, default to working copy (before index 0)
        currentIndex = -1;
      }
    } else {
      // Working copy — before the latest commit
      currentIndex = -1;
    }

    await vscode.commands.executeCommand(
      "setContext",
      "prevNextRevision.canNavigate",
      true
    );
  } catch {
    currentCommits = [];
    currentIndex = -1;
    currentFilePath = "";
    await vscode.commands.executeCommand(
      "setContext",
      "prevNextRevision.canNavigate",
      false
    );
  }
}

function makeGitUri(filePath: string, ref: string): vscode.Uri {
  return vscode.Uri.file(filePath).with({
    scheme: "git",
    query: JSON.stringify({ path: filePath, ref }),
  });
}

async function openDiffWithPrevious() {
  if (currentCommits.length === 0) {
    return;
  }

  // currentIndex: -1 = working copy, 0 = latest commit, etc.
  // "previous" means going to an older commit
  const prevIndex =
    currentIndex === -1 ? 0 : currentIndex + 1;

  if (prevIndex >= currentCommits.length) {
    vscode.window.showInformationMessage("No previous revision available.");
    return;
  }

  const prevCommit = currentCommits[prevIndex];
  const currentLabel =
    currentIndex === -1
      ? "Working Copy"
      : currentCommits[currentIndex].hash.substring(0, 7);

  const leftUri = makeGitUri(currentFilePath, prevCommit.hash);
  const rightUri =
    currentIndex === -1
      ? vscode.Uri.file(currentFilePath)
      : makeGitUri(currentFilePath, currentCommits[currentIndex].hash);

  const fileName = currentFilePath.split("/").pop() || currentFilePath;
  await vscode.commands.executeCommand(
    "vscode.diff",
    leftUri,
    rightUri,
    `${fileName} (${prevCommit.hash.substring(0, 7)} ↔ ${currentLabel})`
  );
}

async function openDiffWithNext() {
  if (currentCommits.length === 0 || currentIndex === -1) {
    vscode.window.showInformationMessage("No next revision available.");
    return;
  }

  const nextIndex = currentIndex - 1;
  const fileName = currentFilePath.split("/").pop() || currentFilePath;
  const currentCommit = currentCommits[currentIndex];

  if (nextIndex < 0) {
    // Next is the working copy
    const leftUri = makeGitUri(currentFilePath, currentCommit.hash);
    const rightUri = vscode.Uri.file(currentFilePath);
    await vscode.commands.executeCommand(
      "vscode.diff",
      leftUri,
      rightUri,
      `${fileName} (${currentCommit.hash.substring(0, 7)} ↔ Working Copy)`
    );
  } else {
    const nextCommit = currentCommits[nextIndex];
    const leftUri = makeGitUri(currentFilePath, currentCommit.hash);
    const rightUri = makeGitUri(currentFilePath, nextCommit.hash);
    await vscode.commands.executeCommand(
      "vscode.diff",
      leftUri,
      rightUri,
      `${fileName} (${currentCommit.hash.substring(0, 7)} ↔ ${nextCommit.hash.substring(0, 7)})`
    );
  }
}

async function showCommit() {
  if (currentCommits.length === 0) {
    return;
  }

  if (currentIndex === -1) {
    // Working copy — show the latest commit
    const commit = currentCommits[0];
    const terminal = vscode.window.createTerminal("Git Show");
    terminal.show();
    terminal.sendText(`git show ${commit.hash}`);
    return;
  }

  const commit = currentCommits[currentIndex];
  const terminal = vscode.window.createTerminal("Git Show");
  terminal.show();
  terminal.sendText(`git show ${commit.hash}`);
}

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "prevNextRevision.previousRevision",
      openDiffWithPrevious
    ),
    vscode.commands.registerCommand(
      "prevNextRevision.nextRevision",
      openDiffWithNext
    ),
    vscode.commands.registerCommand(
      "prevNextRevision.showCommit",
      showCommit
    ),
    vscode.window.onDidChangeActiveTextEditor(updateContext)
  );

  // Set initial context
  updateContext(vscode.window.activeTextEditor);
}

export function deactivate() {}
