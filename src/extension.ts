import * as vscode from "vscode";
import * as path from "path";
import {
  getFileLog,
  getCommitFromUri,
  getRealPath,
  getChangedFiles,
  getRemoteUrl,
  hasUncommittedChanges,
  CommitInfo,
} from "./git";

let currentCommits: CommitInfo[] = [];
let currentIndex = -1;
let currentFilePath = "";
let uncommittedChanges = false;

function setContext(key: string, value: boolean) {
  vscode.commands.executeCommand("setContext", key, value);
}

/**
 * Detect if the active tab is our "uncommitted diff" view
 * (left = git:HEAD, right = file:working-copy).
 */
function isInUncommittedDiff(): boolean {
  const tab = vscode.window.tabGroups.activeTabGroup?.activeTab;
  if (!tab || !(tab.input instanceof vscode.TabInputTextDiff)) {
    return false;
  }
  return (
    tab.input.original.scheme === "git" &&
    tab.input.modified.scheme === "file"
  );
}

function updateNavigationState() {
  const hasHistory = currentCommits.length > 0;
  const inUncommitted = isInUncommittedDiff();

  // hasPrevious: there's an older commit to diff against
  let hasPrevious = false;
  if (hasHistory) {
    if (inUncommitted) {
      // From uncommitted diff, prev goes to commit[0] vs commit[1] (or empty)
      hasPrevious = true;
    } else {
      const prevIndex = currentIndex === -1 ? 0 : currentIndex + 1;
      hasPrevious = prevIndex < currentCommits.length;
    }
  }

  // hasNext: we're viewing a revision (or can advance to uncommitted diff)
  const hasNext =
    hasHistory && (currentIndex >= 0 || (inUncommitted && false));

  // hasCommit: we're viewing a specific revision (not working copy or uncommitted diff)
  const hasCommit = hasHistory && currentIndex >= 0 && !inUncommitted;

  setContext("prevNextRevision.canNavigate", hasHistory);
  setContext("prevNextRevision.hasPrevious", hasPrevious);
  setContext("prevNextRevision.hasNext", hasNext);
  setContext("prevNextRevision.hasCommit", hasCommit);
}

async function updateContext(editor: vscode.TextEditor | undefined) {
  if (!editor) {
    currentCommits = [];
    currentIndex = -1;
    currentFilePath = "";
    uncommittedChanges = false;
    updateNavigationState();
    return;
  }

  const uri = editor.document.uri;

  if (uri.scheme !== "file" && uri.scheme !== "git") {
    currentCommits = [];
    currentIndex = -1;
    currentFilePath = "";
    uncommittedChanges = false;
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
      uncommittedChanges = false;
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
      currentIndex = -1;
    }

    // Only check uncommitted changes when we're on the working copy
    if (currentIndex === -1) {
      uncommittedChanges = await hasUncommittedChanges(filePath);
    } else {
      uncommittedChanges = false;
    }

    updateNavigationState();
  } catch {
    currentCommits = [];
    currentIndex = -1;
    currentFilePath = "";
    uncommittedChanges = false;
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

  const inUncommitted = isInUncommittedDiff();
  const fileName =
    currentFilePath.split("/").pop() || currentFilePath;

  // If on plain working copy with uncommitted changes — show uncommitted diff first
  if (currentIndex === -1 && !inUncommitted && uncommittedChanges) {
    const head = currentCommits[0];
    const leftUri = makeGitUri(head.filePath, head.hash);
    const rightUri = vscode.Uri.file(currentFilePath);
    await vscode.commands.executeCommand(
      "vscode.diff",
      leftUri,
      rightUri,
      `${fileName} (${head.hash.substring(0, 7)} ↔ Working Copy)`
    );
    return;
  }

  // From uncommitted diff, prev steps to commit[0] vs commit[1]
  // From a historical commit, prev steps to one older
  const prevIndex =
    inUncommitted || currentIndex === -1 ? 0 : currentIndex + 1;

  if (prevIndex >= currentCommits.length) {
    return;
  }

  const prevCommit = currentCommits[prevIndex];

  let leftUri: vscode.Uri;

  if (prevIndex + 1 < currentCommits.length) {
    const olderCommit = currentCommits[prevIndex + 1];
    leftUri = makeGitUri(olderCommit.filePath, olderCommit.hash);
  } else {
    leftUri = vscode.Uri.parse(`untitled:${prevCommit.filePath}`);
  }
  const rightUri = makeGitUri(prevCommit.filePath, prevCommit.hash);

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
  const currentCommit = currentCommits[currentIndex];
  const fileName = currentCommit.filePath.split("/").pop() || currentCommit.filePath;

  if (nextIndex < 0) {
    // Next is the working copy (or uncommitted diff if dirty)
    const leftUri = makeGitUri(currentCommit.filePath, currentCommit.hash);
    const rightUri = vscode.Uri.file(currentFilePath);
    await vscode.commands.executeCommand(
      "vscode.diff",
      leftUri,
      rightUri,
      `${fileName} (${currentCommit.hash.substring(0, 7)} ↔ Working Copy)`
    );
  } else {
    const nextCommit = currentCommits[nextIndex];
    const leftUri = makeGitUri(currentCommit.filePath, currentCommit.hash);
    const rightUri = makeGitUri(nextCommit.filePath, nextCommit.hash);
    await vscode.commands.executeCommand(
      "vscode.diff",
      leftUri,
      rightUri,
      `${fileName} (${nextCommit.hash.substring(0, 7)} — ${nextCommit.subject})`
    );
  }
}

async function showCommit() {
  if (currentCommits.length === 0 || currentIndex < 0) {
    return;
  }

  const commit = currentCommits[currentIndex];
  const shortSha = commit.hash.substring(0, 7);

  const items: vscode.QuickPickItem[] = [
    {
      label: `$(git-commit) ${shortSha}`,
      description: commit.subject,
      detail: commit.date,
      kind: vscode.QuickPickItemKind.Default,
    },
    { label: "", kind: vscode.QuickPickItemKind.Separator },
    {
      label: "$(clippy) Copy SHA",
      description: commit.hash,
    },
    {
      label: "$(globe) Open on GitHub",
    },
    {
      label: "$(diff) Open Commit Details",
      description: "Show all changed files",
    },
  ];

  const picked = await vscode.window.showQuickPick(items, {
    title: `Commit ${shortSha}`,
    placeHolder: commit.subject,
  });

  if (!picked) {
    return;
  }

  if (picked.label.includes("Copy SHA")) {
    await vscode.env.clipboard.writeText(commit.hash);
    vscode.window.showInformationMessage(`Copied ${commit.hash}`);
  } else if (picked.label.includes("Open on GitHub")) {
    const remoteUrl = await getRemoteUrl(currentFilePath);
    if (remoteUrl) {
      await vscode.env.openExternal(
        vscode.Uri.parse(`${remoteUrl}/commit/${commit.hash}`)
      );
    } else {
      vscode.window.showWarningMessage("No remote URL found.");
    }
  } else if (picked.label.includes("Open Commit Details")) {
    await openCommitDetails(commit);
  }
}

async function openCommitDetails(commit: CommitInfo) {
  const files = await getChangedFiles(currentFilePath, commit.hash);
  if (files.length === 0) {
    vscode.window.showInformationMessage("No changed files in this commit.");
    return;
  }

  const cwd =
    vscode.workspace.getWorkspaceFolder(vscode.Uri.file(currentFilePath))
      ?.uri.fsPath || "";

  const fileItems: vscode.QuickPickItem[] = files.map((f) => {
    const icon =
      f.status === "A"
        ? "$(diff-added)"
        : f.status === "D"
          ? "$(diff-removed)"
          : "$(diff-modified)";
    return {
      label: `${icon} ${f.file}`,
      description: f.status,
    };
  });

  const picked = await vscode.window.showQuickPick(fileItems, {
    title: `Changed files in ${commit.hash.substring(0, 7)}`,
    placeHolder: `${files.length} file(s) changed`,
  });

  if (!picked) {
    return;
  }

  // Extract filename from the label (after the icon)
  const fileName = picked.label.replace(/^\$\([^)]+\)\s*/, "");
  const filePath = path.join(cwd, fileName);
  const status = picked.description;

  if (status === "A") {
    // Added file — diff against empty
    const leftUri = vscode.Uri.parse(`untitled:${filePath}`);
    const rightUri = makeGitUri(filePath, commit.hash);
    await vscode.commands.executeCommand(
      "vscode.diff",
      leftUri,
      rightUri,
      `${fileName} (added in ${commit.hash.substring(0, 7)})`
    );
  } else if (status === "D") {
    // Deleted file — diff against empty
    const leftUri = makeGitUri(filePath, `${commit.hash}~1`);
    const rightUri = vscode.Uri.parse(`untitled:${filePath}`);
    await vscode.commands.executeCommand(
      "vscode.diff",
      leftUri,
      rightUri,
      `${fileName} (deleted in ${commit.hash.substring(0, 7)})`
    );
  } else {
    // Modified — diff parent vs commit
    const leftUri = makeGitUri(filePath, `${commit.hash}~1`);
    const rightUri = makeGitUri(filePath, commit.hash);
    await vscode.commands.executeCommand(
      "vscode.diff",
      leftUri,
      rightUri,
      `${fileName} (${commit.hash.substring(0, 7)})`
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
    vscode.commands.registerCommand(
      "prevNextRevision.showCommit",
      showCommit
    ),
    vscode.window.onDidChangeActiveTextEditor(updateContext),
    vscode.window.tabGroups.onDidChangeTabs(() => {
      updateContext(vscode.window.activeTextEditor);
    })
  );

  updateContext(vscode.window.activeTextEditor);
}

export function deactivate() {}
