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

function setContext(key: string, value: boolean) {
  vscode.commands.executeCommand("setContext", key, value);
}

function updateNavigationState() {
  const hasHistory = currentCommits.length > 0;

  // hasPrevious: there's an older commit to diff against
  const prevIndex = currentIndex === -1 ? 0 : currentIndex + 1;
  const hasPrevious = hasHistory && prevIndex < currentCommits.length;

  // hasNext: we're viewing a revision and there's a newer one (or working copy)
  const hasNext = hasHistory && currentIndex >= 0;

  setContext("prevNextRevision.canNavigate", hasHistory);
  setContext("prevNextRevision.hasPrevious", hasPrevious);
  setContext("prevNextRevision.hasNext", hasNext);
}

async function updateContext(editor: vscode.TextEditor | undefined) {
  if (!editor) {
    currentCommits = [];
    currentIndex = -1;
    currentFilePath = "";
    updateNavigationState();
    return;
  }

  const uri = editor.document.uri;

  if (uri.scheme !== "file" && uri.scheme !== "git") {
    currentCommits = [];
    currentIndex = -1;
    currentFilePath = "";
    updateNavigationState();
    return;
  }

  const filePath = getRealPath(uri);

  try {
    const commits = await getFileLog(filePath);
    if (commits.length === 0) {
      currentCommits = [];
      currentIndex = -1;
      currentFilePath = "";
      updateNavigationState();
      return;
    }

    currentCommits = commits;
    currentFilePath = filePath;

    const commitHash = getCommitFromUri(uri);
    if (commitHash) {
      currentIndex = commits.findIndex((c) =>
        c.hash.startsWith(commitHash)
      );
      if (currentIndex === -1) {
        currentIndex = -1;
      }
    } else {
      // Working copy
      currentIndex = -1;
    }

    updateNavigationState();
  } catch {
    currentCommits = [];
    currentIndex = -1;
    currentFilePath = "";
    updateNavigationState();
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
  const prevIndex = currentIndex === -1 ? 0 : currentIndex + 1;

  if (prevIndex >= currentCommits.length) {
    return;
  }

  const prevCommit = currentCommits[prevIndex];

  // Always diff between two contiguous commits
  // Left = older (prevIndex), Right = newer (prevIndex - 1), or working copy if prevIndex == 0 and currentIndex == -1
  let leftUri: vscode.Uri;
  let rightUri: vscode.Uri;
  let currentLabel: string;

  if (prevIndex + 1 < currentCommits.length) {
    // There's an even older commit — left side is prevCommit's parent in our log
    leftUri = makeGitUri(currentFilePath, currentCommits[prevIndex + 1].hash);
  } else {
    // This is the oldest commit — diff against empty (all green)
    leftUri = vscode.Uri.parse(`untitled:${currentFilePath}`);
  }
  rightUri = makeGitUri(currentFilePath, prevCommit.hash);
  currentLabel = prevCommit.hash.substring(0, 7);

  const fileName = currentFilePath.split("/").pop() || currentFilePath;
  await vscode.commands.executeCommand(
    "vscode.diff",
    leftUri,
    rightUri,
    `${fileName} (${prevCommit.hash.substring(0, 7)} — ${prevCommit.subject})`
  );
}

async function openDiffWithNext() {
  if (currentCommits.length === 0 || currentIndex < 0) {
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
      `${fileName} (${nextCommit.hash.substring(0, 7)} — ${nextCommit.subject})`
    );
  }
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
    vscode.window.onDidChangeActiveTextEditor(updateContext)
  );

  updateContext(vscode.window.activeTextEditor);
}

export function deactivate() {}
