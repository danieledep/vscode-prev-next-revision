import * as vscode from "vscode";
import * as path from "path";
import {
  getFileLog,
  getFileAtCommit,
  getCommitFromUri,
  getRealPath,
  getChangedFiles,
  getRemoteUrl,
  hasUncommittedChanges,
  getBlameForLine,
  CommitInfo,
} from "./git";

const REVISION_SCHEME = "pnr-revision";

let currentCommits: CommitInfo[] = [];
let currentIndex = -1;
let currentFilePath = "";
let uncommittedChanges = false;

const blameDecorationType = vscode.window.createTextEditorDecorationType({
  after: {
    color: new vscode.ThemeColor("editorCodeLens.foreground"),
    fontStyle: "italic",
    margin: "0 0 0 3em",
  },
  rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
});

let blameTimeout: ReturnType<typeof setTimeout> | undefined;

/**
 * Text document content provider for our custom revision URIs.
 * Runs `git show` directly — more robust than VS Code's built-in git: scheme.
 */
class RevisionContentProvider
  implements vscode.TextDocumentContentProvider
{
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const ref = getCommitFromUri(uri);
    if (!ref) {
      return "";
    }
    return getFileAtCommit(uri.fsPath, ref);
  }
}

function makeRevisionUri(filePath: string, ref: string): vscode.Uri {
  return vscode.Uri.file(filePath).with({
    scheme: REVISION_SCHEME,
    query: `ref=${encodeURIComponent(ref)}`,
  });
}

function setContext(key: string, value: boolean) {
  vscode.commands.executeCommand("setContext", key, value);
}

/**
 * Detect if the active tab is our "uncommitted diff" view
 * (left = revision, right = file:working-copy).
 */
function isInUncommittedDiff(): boolean {
  const tab = vscode.window.tabGroups.activeTabGroup?.activeTab;
  if (!tab || !(tab.input instanceof vscode.TabInputTextDiff)) {
    return false;
  }
  const leftScheme = tab.input.original.scheme;
  return (
    (leftScheme === REVISION_SCHEME || leftScheme === "git") &&
    tab.input.modified.scheme === "file"
  );
}

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

  const hasNext = hasHistory && currentIndex >= 0;
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

  if (
    uri.scheme !== "file" &&
    uri.scheme !== "git" &&
    uri.scheme !== REVISION_SCHEME
  ) {
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

async function openDiffWithPrevious() {
  if (currentCommits.length === 0) {
    return;
  }

  const inUncommitted = isInUncommittedDiff();
  const fileName = currentFilePath.split("/").pop() || currentFilePath;

  // If on plain working copy with uncommitted changes — show uncommitted diff first
  if (currentIndex === -1 && !inUncommitted && uncommittedChanges) {
    const head = currentCommits[0];
    const leftUri = makeRevisionUri(head.filePath, head.hash);
    const rightUri = vscode.Uri.file(currentFilePath);
    await vscode.commands.executeCommand(
      "vscode.diff",
      leftUri,
      rightUri,
      `${fileName} (${head.hash.substring(0, 7)} ↔ Working Copy)`
    );
    return;
  }

  const prevIndex =
    inUncommitted || currentIndex === -1 ? 0 : currentIndex + 1;

  if (prevIndex >= currentCommits.length) {
    return;
  }

  const prevCommit = currentCommits[prevIndex];

  let leftUri: vscode.Uri;

  if (prevIndex + 1 < currentCommits.length) {
    const olderCommit = currentCommits[prevIndex + 1];
    leftUri = makeRevisionUri(olderCommit.filePath, olderCommit.hash);
  } else {
    leftUri = vscode.Uri.parse(`untitled:${prevCommit.filePath}`);
  }
  const rightUri = makeRevisionUri(prevCommit.filePath, prevCommit.hash);

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
  const fileName =
    currentCommit.filePath.split("/").pop() || currentCommit.filePath;

  if (nextIndex < 0) {
    const leftUri = makeRevisionUri(currentCommit.filePath, currentCommit.hash);
    const rightUri = vscode.Uri.file(currentFilePath);
    await vscode.commands.executeCommand(
      "vscode.diff",
      leftUri,
      rightUri,
      `${fileName} (${currentCommit.hash.substring(0, 7)} ↔ Working Copy)`
    );
  } else {
    const nextCommit = currentCommits[nextIndex];
    const leftUri = makeRevisionUri(currentCommit.filePath, currentCommit.hash);
    const rightUri = makeRevisionUri(nextCommit.filePath, nextCommit.hash);
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

  const fileName = picked.label.replace(/^\$\([^)]+\)\s*/, "");
  const filePath = path.join(cwd, fileName);
  const status = picked.description;

  if (status === "A") {
    const leftUri = vscode.Uri.parse(`untitled:${filePath}`);
    const rightUri = makeRevisionUri(filePath, commit.hash);
    await vscode.commands.executeCommand(
      "vscode.diff",
      leftUri,
      rightUri,
      `${fileName} (added in ${commit.hash.substring(0, 7)})`
    );
  } else if (status === "D") {
    const leftUri = makeRevisionUri(filePath, `${commit.hash}~1`);
    const rightUri = vscode.Uri.parse(`untitled:${filePath}`);
    await vscode.commands.executeCommand(
      "vscode.diff",
      leftUri,
      rightUri,
      `${fileName} (deleted in ${commit.hash.substring(0, 7)})`
    );
  } else {
    const leftUri = makeRevisionUri(filePath, `${commit.hash}~1`);
    const rightUri = makeRevisionUri(filePath, commit.hash);
    await vscode.commands.executeCommand(
      "vscode.diff",
      leftUri,
      rightUri,
      `${fileName} (${commit.hash.substring(0, 7)})`
    );
  }
}

function formatTimeAgo(timestamp: number): string {
  const seconds = Math.floor(Date.now() / 1000 - timestamp);
  if (seconds < 60) { return "just now"; }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) { return `${minutes} minute${minutes > 1 ? "s" : ""} ago`; }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) { return `${hours} hour${hours > 1 ? "s" : ""} ago`; }
  const days = Math.floor(hours / 24);
  if (days < 30) { return `${days} day${days > 1 ? "s" : ""} ago`; }
  const months = Math.floor(days / 30);
  if (months < 12) { return `${months} month${months > 1 ? "s" : ""} ago`; }
  const years = Math.floor(months / 12);
  return `${years} year${years > 1 ? "s" : ""} ago`;
}

async function updateBlame(editor: vscode.TextEditor | undefined) {
  if (!editor) {
    return;
  }
  const uri = editor.document.uri;
  if (
    uri.scheme !== "file" &&
    uri.scheme !== "git" &&
    uri.scheme !== REVISION_SCHEME
  ) {
    editor.setDecorations(blameDecorationType, []);
    return;
  }

  const line = editor.selection.active.line;
  if (line >= editor.document.lineCount) {
    editor.setDecorations(blameDecorationType, []);
    return;
  }

  const filePath = getRealPath(uri);
  const ref = getCommitFromUri(uri);

  const blame = await getBlameForLine(filePath, line, ref);
  if (!blame) {
    editor.setDecorations(blameDecorationType, []);
    return;
  }

  const text = `${blame.author}, ${formatTimeAgo(blame.authorTime)} \u2022 ${blame.summary}`;
  const range = editor.document.lineAt(line).range;
  editor.setDecorations(blameDecorationType, [
    {
      range,
      renderOptions: { after: { contentText: text } },
    },
  ]);
}

function scheduleBlameUpdate(editor: vscode.TextEditor | undefined) {
  if (blameTimeout) {
    clearTimeout(blameTimeout);
  }
  blameTimeout = setTimeout(() => updateBlame(editor), 150);
}

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      REVISION_SCHEME,
      new RevisionContentProvider()
    ),
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
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      updateContext(editor);
      scheduleBlameUpdate(editor);
    }),
    vscode.window.onDidChangeTextEditorSelection((e) => {
      scheduleBlameUpdate(e.textEditor);
    }),
    vscode.window.tabGroups.onDidChangeTabs(() => {
      updateContext(vscode.window.activeTextEditor);
    })
  );

  updateContext(vscode.window.activeTextEditor);
  scheduleBlameUpdate(vscode.window.activeTextEditor);
}

export function deactivate() {}
