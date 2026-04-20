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

// --- State ---

let currentCommits: CommitInfo[] = [];
let currentIndex = -1;
let currentFilePath = "";
let uncommittedChanges = false;
let contextVersion = 0;
let hideTimeout: ReturnType<typeof setTimeout> | undefined;

// --- Empty content provider (for first-commit diffs) ---

const EMPTY_SCHEME = "pnr-empty";

class EmptyContentProvider implements vscode.TextDocumentContentProvider {
  provideTextDocumentContent(): string {
    return "";
  }
}

function emptyUri(filePath: string): vscode.Uri {
  return vscode.Uri.from({ scheme: EMPTY_SCHEME, path: filePath });
}

// --- URI / tab helpers ---

/**
 * Build a VS Code built-in git-scheme URI. The built-in git extension's
 * content provider resolves these, which gives us inline blame for free.
 */
function toGitUri(filePath: string, ref: string): vscode.Uri {
  return vscode.Uri.file(filePath).with({
    scheme: "git",
    query: JSON.stringify({ path: filePath, ref }),
  });
}

function shortSha(hash: string): string {
  return hash.substring(0, 8);
}

function basename(filePath: string): string {
  return path.basename(filePath);
}

function diffTitle(
  leftPath: string,
  leftLabel: string,
  rightPath: string,
  rightLabel: string
): string {
  return `${basename(leftPath)} (${leftLabel}) \u2194 ${basename(rightPath)} (${rightLabel})`;
}

function setContext(key: string, value: boolean) {
  vscode.commands.executeCommand("setContext", key, value);
}

function isGitScheme(scheme: string): boolean {
  return scheme === "file" || scheme === "git";
}

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

function resetState() {
  currentCommits = [];
  currentIndex = -1;
  currentFilePath = "";
  uncommittedChanges = false;
}

// --- Navigation state ---

function updateNavigationState() {
  const hasHistory = currentCommits.length > 0;
  const inUncommitted = isInUncommittedDiff();

  let hasPrevious = false;
  if (hasHistory) {
    if (inUncommitted) {
      hasPrevious = true;
    } else {
      const prevIndex = currentIndex === -1 ? 0 : currentIndex + 1;
      hasPrevious = prevIndex < currentCommits.length;
    }
  }

  setContext("prevNextRevision.canNavigate", hasHistory);
  setContext("prevNextRevision.hasPrevious", hasPrevious);
  setContext("prevNextRevision.hasNext", hasHistory && currentIndex >= 0);
  setContext(
    "prevNextRevision.hasCommit",
    hasHistory && currentIndex >= 0 && !inUncommitted
  );
}

async function updateContext(editor: vscode.TextEditor | undefined) {
  const version = ++contextVersion;

  if (hideTimeout) {
    clearTimeout(hideTimeout);
    hideTimeout = undefined;
  }

  if (!editor || !isGitScheme(editor.document.uri.scheme)) {
    hideTimeout = setTimeout(() => {
      if (version !== contextVersion) { return; }
      resetState();
      updateNavigationState();
    }, 200);
    return;
  }

  const filePath = getRealPath(editor.document.uri);

  try {
    const commits = await getFileLog(filePath);
    if (version !== contextVersion) { return; }

    if (commits.length === 0) {
      resetState();
      updateNavigationState();
      return;
    }

    currentCommits = commits;
    currentFilePath = filePath;

    const commitHash = getCommitFromUri(editor.document.uri);
    currentIndex = commitHash
      ? commits.findIndex((c) => c.hash.startsWith(commitHash))
      : -1;

    if (currentIndex === -1) {
      uncommittedChanges = await hasUncommittedChanges(filePath);
      if (version !== contextVersion) { return; }
    } else {
      uncommittedChanges = false;
    }

    updateNavigationState();
  } catch {
    if (version !== contextVersion) { return; }
    resetState();
    updateNavigationState();
  }
}

// --- Diff navigation ---

async function openDiffWithPrevious() {
  if (currentCommits.length === 0) {
    return;
  }

  const inUncommitted = isInUncommittedDiff();

  if (currentIndex === -1 && !inUncommitted && uncommittedChanges) {
    const head = currentCommits[0];
    await vscode.commands.executeCommand(
      "vscode.diff",
      toGitUri(head.filePath, head.hash),
      vscode.Uri.file(currentFilePath),
      diffTitle(head.filePath, shortSha(head.hash), currentFilePath, "Working Tree")
    );
    return;
  }

  const prevIndex =
    inUncommitted || currentIndex === -1 ? 0 : currentIndex + 1;

  if (prevIndex >= currentCommits.length) {
    return;
  }

  const prevCommit = currentCommits[prevIndex];
  const older = currentCommits[prevIndex + 1];

  const leftUri = older
    ? toGitUri(older.filePath, older.hash)
    : emptyUri(prevCommit.filePath);
  const rightUri = toGitUri(prevCommit.filePath, prevCommit.hash);

  const leftLabel = older ? shortSha(older.hash) : "\u2205";
  const leftPath = older ? older.filePath : prevCommit.filePath;

  await vscode.commands.executeCommand(
    "vscode.diff",
    leftUri,
    rightUri,
    diffTitle(leftPath, leftLabel, prevCommit.filePath, shortSha(prevCommit.hash))
  );
}

async function openDiffWithNext() {
  if (currentCommits.length === 0 || currentIndex < 0) {
    return;
  }

  const currentCommit = currentCommits[currentIndex];
  const nextIndex = currentIndex - 1;

  if (nextIndex < 0) {
    await vscode.commands.executeCommand(
      "vscode.diff",
      toGitUri(currentCommit.filePath, currentCommit.hash),
      vscode.Uri.file(currentFilePath),
      diffTitle(
        currentCommit.filePath,
        shortSha(currentCommit.hash),
        currentFilePath,
        "Working Tree"
      )
    );
    return;
  }

  const nextCommit = currentCommits[nextIndex];
  await vscode.commands.executeCommand(
    "vscode.diff",
    toGitUri(currentCommit.filePath, currentCommit.hash),
    toGitUri(nextCommit.filePath, nextCommit.hash),
    diffTitle(
      currentCommit.filePath,
      shortSha(currentCommit.hash),
      nextCommit.filePath,
      shortSha(nextCommit.hash)
    )
  );
}

// --- Commit info ---

async function showCommit() {
  if (currentCommits.length === 0 || currentIndex < 0) {
    return;
  }

  const commit = currentCommits[currentIndex];
  const sha = shortSha(commit.hash);

  const items: vscode.QuickPickItem[] = [
    {
      label: `$(git-commit) ${sha}`,
      description: commit.subject,
      detail: commit.date,
      kind: vscode.QuickPickItemKind.Default,
    },
    { label: "", kind: vscode.QuickPickItemKind.Separator },
    { label: "$(clippy) Copy SHA", description: commit.hash },
    { label: "$(globe) Open on GitHub" },
    { label: "$(diff) Open Commit Details", description: "Show all changed files" },
  ];

  const picked = await vscode.window.showQuickPick(items, {
    title: `Commit ${sha}`,
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
    return { label: `${icon} ${f.file}`, description: f.status };
  });

  const picked = await vscode.window.showQuickPick(fileItems, {
    title: `Changed files in ${shortSha(commit.hash)}`,
    placeHolder: `${files.length} file(s) changed`,
  });
  if (!picked) {
    return;
  }

  const fileName = picked.label.replace(/^\$\([^)]+\)\s*/, "");
  const filePath = path.join(cwd, fileName);
  const status = picked.description;
  const sha = shortSha(commit.hash);

  let leftUri: vscode.Uri;
  let rightUri: vscode.Uri;
  let title: string;

  if (status === "A") {
    leftUri = emptyUri(filePath);
    rightUri = toGitUri(filePath, commit.hash);
    title = diffTitle(filePath, "\u2205", filePath, sha);
  } else if (status === "D") {
    leftUri = toGitUri(filePath, `${commit.hash}~1`);
    rightUri = emptyUri(filePath);
    title = diffTitle(filePath, `${sha}~1`, filePath, sha);
  } else {
    leftUri = toGitUri(filePath, `${commit.hash}~1`);
    rightUri = toGitUri(filePath, commit.hash);
    title = diffTitle(filePath, `${sha}~1`, filePath, sha);
  }

  await vscode.commands.executeCommand("vscode.diff", leftUri, rightUri, title);
}

// --- Activation ---

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      EMPTY_SCHEME,
      new EmptyContentProvider()
    ),
    vscode.commands.registerCommand(
      "prevNextRevision.previousRevision",
      openDiffWithPrevious
    ),
    vscode.commands.registerCommand(
      "prevNextRevision.nextRevision",
      openDiffWithNext
    ),
    vscode.commands.registerCommand("prevNextRevision.showCommit", showCommit),
    vscode.window.onDidChangeActiveTextEditor(updateContext),
    vscode.window.tabGroups.onDidChangeTabs(() => {
      updateContext(vscode.window.activeTextEditor);
    })
  );

  updateContext(vscode.window.activeTextEditor);
}

export function deactivate() {}
