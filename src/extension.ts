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

// --- State ---

let currentCommits: CommitInfo[] = [];
let currentIndex = -1;
let currentFilePath = "";
let uncommittedChanges = false;
let contextVersion = 0;
let blameVersion = 0;
let blameTimeout: ReturnType<typeof setTimeout> | undefined;

const blameDecorationType = vscode.window.createTextEditorDecorationType({
  after: {
    color: new vscode.ThemeColor("editorCodeLens.foreground"),
    fontStyle: "italic",
    margin: "0 0 0 3em",
  },
  rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
});

// --- Content provider ---

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

// --- Helpers ---

function makeRevisionUri(filePath: string, ref: string): vscode.Uri {
  return vscode.Uri.file(filePath).with({
    scheme: REVISION_SCHEME,
    query: `ref=${encodeURIComponent(ref)}`,
  });
}

function setContext(key: string, value: boolean) {
  vscode.commands.executeCommand("setContext", key, value);
}

function isGitScheme(scheme: string): boolean {
  return scheme === "file" || scheme === "git" || scheme === REVISION_SCHEME;
}

function isInUncommittedDiff(): boolean {
  const tab = vscode.window.tabGroups.activeTabGroup?.activeTab;
  if (!tab || !(tab.input instanceof vscode.TabInputTextDiff)) {
    return false;
  }
  return (
    (tab.input.original.scheme === REVISION_SCHEME ||
      tab.input.original.scheme === "git") &&
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

// --- Context update (with version guard) ---

async function updateContext(editor: vscode.TextEditor | undefined) {
  const version = ++contextVersion;

  if (!editor || !isGitScheme(editor.document.uri.scheme)) {
    resetState();
    updateNavigationState();
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
  const fileName = currentFilePath.split("/").pop() || currentFilePath;

  if (currentIndex === -1 && !inUncommitted && uncommittedChanges) {
    const head = currentCommits[0];
    await vscode.commands.executeCommand(
      "vscode.diff",
      makeRevisionUri(head.filePath, head.hash),
      vscode.Uri.file(currentFilePath),
      `${fileName} (${head.hash.substring(0, 7)} \u2194 Working Copy)`
    );
    return;
  }

  const prevIndex =
    inUncommitted || currentIndex === -1 ? 0 : currentIndex + 1;

  if (prevIndex >= currentCommits.length) {
    return;
  }

  const prevCommit = currentCommits[prevIndex];
  const leftUri =
    prevIndex + 1 < currentCommits.length
      ? makeRevisionUri(
          currentCommits[prevIndex + 1].filePath,
          currentCommits[prevIndex + 1].hash
        )
      : vscode.Uri.parse(`untitled:${prevCommit.filePath}`);

  await vscode.commands.executeCommand(
    "vscode.diff",
    leftUri,
    makeRevisionUri(prevCommit.filePath, prevCommit.hash),
    `${fileName} (${prevCommit.hash.substring(0, 7)} \u2014 ${prevCommit.subject})`
  );
}

async function openDiffWithNext() {
  if (currentCommits.length === 0 || currentIndex < 0) {
    return;
  }

  const currentCommit = currentCommits[currentIndex];
  const fileName =
    currentCommit.filePath.split("/").pop() || currentCommit.filePath;
  const nextIndex = currentIndex - 1;

  if (nextIndex < 0) {
    await vscode.commands.executeCommand(
      "vscode.diff",
      makeRevisionUri(currentCommit.filePath, currentCommit.hash),
      vscode.Uri.file(currentFilePath),
      `${fileName} (${currentCommit.hash.substring(0, 7)} \u2194 Working Copy)`
    );
  } else {
    const nextCommit = currentCommits[nextIndex];
    await vscode.commands.executeCommand(
      "vscode.diff",
      makeRevisionUri(currentCommit.filePath, currentCommit.hash),
      makeRevisionUri(nextCommit.filePath, nextCommit.hash),
      `${fileName} (${nextCommit.hash.substring(0, 7)} \u2014 ${nextCommit.subject})`
    );
  }
}

// --- Commit info ---

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
    { label: "$(clippy) Copy SHA", description: commit.hash },
    { label: "$(globe) Open on GitHub" },
    { label: "$(diff) Open Commit Details", description: "Show all changed files" },
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
    return { label: `${icon} ${f.file}`, description: f.status };
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
    await vscode.commands.executeCommand(
      "vscode.diff",
      vscode.Uri.parse(`untitled:${filePath}`),
      makeRevisionUri(filePath, commit.hash),
      `${fileName} (added in ${commit.hash.substring(0, 7)})`
    );
  } else if (status === "D") {
    await vscode.commands.executeCommand(
      "vscode.diff",
      makeRevisionUri(filePath, `${commit.hash}~1`),
      vscode.Uri.parse(`untitled:${filePath}`),
      `${fileName} (deleted in ${commit.hash.substring(0, 7)})`
    );
  } else {
    await vscode.commands.executeCommand(
      "vscode.diff",
      makeRevisionUri(filePath, `${commit.hash}~1`),
      makeRevisionUri(filePath, commit.hash),
      `${fileName} (${commit.hash.substring(0, 7)})`
    );
  }
}

// --- Inline blame ---

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

async function updateBlame() {
  const version = ++blameVersion;
  const editor = vscode.window.activeTextEditor;

  if (!editor || !isGitScheme(editor.document.uri.scheme)) {
    editor?.setDecorations(blameDecorationType, []);
    return;
  }

  const line = editor.selection.active.line;
  if (line >= editor.document.lineCount) {
    editor.setDecorations(blameDecorationType, []);
    return;
  }

  const filePath = getRealPath(editor.document.uri);
  const ref = getCommitFromUri(editor.document.uri);
  const blame = await getBlameForLine(filePath, line, ref);

  if (version !== blameVersion) { return; }

  const currentEditor = vscode.window.activeTextEditor;
  if (currentEditor !== editor) { return; }

  if (!blame) {
    editor.setDecorations(blameDecorationType, []);
    return;
  }

  const text = `${blame.author}, ${formatTimeAgo(blame.authorTime)} \u2022 ${blame.summary}`;
  editor.setDecorations(blameDecorationType, [
    {
      range: editor.document.lineAt(line).range,
      renderOptions: { after: { contentText: text } },
    },
  ]);
}

function scheduleBlameUpdate() {
  if (blameTimeout) {
    clearTimeout(blameTimeout);
  }
  blameTimeout = setTimeout(updateBlame, 150);
}

// --- Activation ---

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
    vscode.commands.registerCommand("prevNextRevision.showCommit", showCommit),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      updateContext(editor);
      scheduleBlameUpdate();
    }),
    vscode.window.onDidChangeTextEditorSelection(() => {
      scheduleBlameUpdate();
    }),
    vscode.window.tabGroups.onDidChangeTabs(() => {
      updateContext(vscode.window.activeTextEditor);
    })
  );

  updateContext(vscode.window.activeTextEditor);
  scheduleBlameUpdate();
}

export function deactivate() {}
