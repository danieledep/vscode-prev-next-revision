import * as vscode from "vscode";
import * as path from "path";
import {
  getFileLog,
  getCommitFromUri,
  getRealPath,
  getChangedFiles,
  getRemoteUrl,
  getRepoRoot,
  hasUncommittedChanges,
  CommitInfo,
} from "./git";
import {
  GIST_REVISION_SCHEME,
  GistRevisionContentProvider,
  findChangedRevision,
  getGistChangedFiles,
  getGistFileName,
  getGistId,
  getGistLog,
  getGistRevisionFromUri,
  gistFileUri,
  gistRevisionUri,
  isGistScheme,
} from "./gist";

// --- State ---

let currentCommits: CommitInfo[] = [];
let currentIndex = -1;
let currentFilePath = "";
/** Set while the active editor shows a GistPad gist, cleared for plain files. */
let currentGistId: string | undefined;
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

const RELATIVE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 60 * 60 * 1000],
  ["month", 30 * 24 * 60 * 60 * 1000],
  ["week", 7 * 24 * 60 * 60 * 1000],
  ["day", 24 * 60 * 60 * 1000],
  ["hour", 60 * 60 * 1000],
  ["minute", 60 * 1000],
];

/**
 * "1 month ago (14 August 2026 at 14:34)". The absolute half follows the
 * editor's own locale and time zone, so the same commit reads
 * "August 14, 2026 at 2:34 PM" on a US machine.
 */
function describeDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }

  const absolute = new Intl.DateTimeFormat(undefined, {
    dateStyle: "long",
    timeStyle: "short",
  }).format(date);

  const relative = new Intl.RelativeTimeFormat(undefined, {
    numeric: "always",
  });
  const elapsed = Date.now() - date.getTime();
  const [unit, size] = RELATIVE_UNITS.find(
    ([, ms]) => Math.abs(elapsed) >= ms
  ) ?? ["second", 1000];

  return `${relative.format(-Math.round(elapsed / size), unit)} (${absolute})`;
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

function isSupportedScheme(scheme: string): boolean {
  return scheme === "file" || scheme === "git" || isGistScheme(scheme);
}

/**
 * A revision of `filePath`. Gists are versioned by GitHub rather than by git,
 * so they get their own content provider instead of the built-in git: scheme.
 */
function revisionUri(filePath: string, hash: string): vscode.Uri {
  return currentGistId
    ? gistRevisionUri(currentGistId, filePath, hash)
    : toGitUri(filePath, hash);
}

/** The live, editable document the newest revision is compared against. */
function workingUri(): vscode.Uri {
  return currentGistId
    ? gistFileUri(currentGistId, currentFilePath)
    : vscode.Uri.file(currentFilePath);
}

/**
 * The URI to read history from. A deleted file is diffed against the empty
 * placeholder, and that placeholder is the side VS Code focuses, so follow the
 * tab across to the real side rather than dropping the buttons.
 */
function historyUri(
  editor: vscode.TextEditor | undefined
): vscode.Uri | undefined {
  const uri = editor?.document.uri;
  if (!uri || uri.scheme !== EMPTY_SCHEME) {
    return uri;
  }

  const tab = vscode.window.tabGroups.activeTabGroup?.activeTab;
  if (tab?.input instanceof vscode.TabInputTextDiff) {
    const { original, modified } = tab.input;
    return original.scheme === EMPTY_SCHEME ? modified : original;
  }
  return uri;
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
  currentGistId = undefined;
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

  const uri = historyUri(editor);

  if (!uri || !isSupportedScheme(uri.scheme)) {
    hideTimeout = setTimeout(() => {
      if (version !== contextVersion) { return; }
      resetState();
      updateNavigationState();
    }, 200);
    return;
  }

  const gistId = getGistId(uri);
  const filePath = gistId ? getGistFileName(uri) : getRealPath(uri);

  try {
    const commits = gistId
      ? await getGistLog(gistId, filePath)
      : await getFileLog(filePath);
    if (version !== contextVersion) { return; }

    if (commits.length === 0) {
      resetState();
      updateNavigationState();
      return;
    }

    currentCommits = commits;
    currentFilePath = filePath;
    currentGistId = gistId;

    const commitHash = gistId
      ? getGistRevisionFromUri(uri)
      : getCommitFromUri(uri);
    currentIndex = commitHash
      ? commits.findIndex((c) => c.hash.startsWith(commitHash))
      : -1;

    // A gist has no working copy: its live file is always the newest revision.
    if (currentIndex === -1 && !gistId) {
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

/**
 * Resolve the revision to land on when stepping from `index` (1 = older,
 * -1 = newer). Git history is already filtered to this file, but gist
 * revisions span the whole gist, so those need the untouched ones skipped.
 */
async function stepToRevision(
  index: number,
  direction: 1 | -1
): Promise<number | undefined> {
  if (index < 0) {
    return undefined;
  }
  return currentGistId
    ? findChangedRevision(
        currentGistId,
        currentFilePath,
        currentCommits,
        index,
        direction
      )
    : index;
}

async function openDiffWithPrevious() {
  if (currentCommits.length === 0) {
    return;
  }

  const inUncommitted = isInUncommittedDiff();

  if (currentIndex === -1 && !inUncommitted && uncommittedChanges) {
    const head = currentCommits[0];
    await vscode.commands.executeCommand(
      "vscode.diff",
      revisionUri(head.filePath, head.hash),
      workingUri(),
      diffTitle(head.filePath, shortSha(head.hash), currentFilePath, "Working Tree")
    );
    return;
  }

  const prevIndex = await stepToRevision(
    inUncommitted || currentIndex === -1 ? 0 : currentIndex + 1,
    1
  );

  if (prevIndex === undefined || prevIndex >= currentCommits.length) {
    return;
  }

  const prevCommit = currentCommits[prevIndex];
  const older = currentCommits[prevIndex + 1];

  const leftUri = older
    ? revisionUri(older.filePath, older.hash)
    : emptyUri(prevCommit.filePath);
  const rightUri = revisionUri(prevCommit.filePath, prevCommit.hash);

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
  const nextIndex = await stepToRevision(currentIndex - 1, -1);

  if (nextIndex === undefined) {
    await vscode.commands.executeCommand(
      "vscode.diff",
      revisionUri(currentCommit.filePath, currentCommit.hash),
      workingUri(),
      diffTitle(
        currentCommit.filePath,
        shortSha(currentCommit.hash),
        currentFilePath,
        currentGistId ? "Latest" : "Working Tree"
      )
    );
    return;
  }

  const nextCommit = currentCommits[nextIndex];
  await vscode.commands.executeCommand(
    "vscode.diff",
    revisionUri(currentCommit.filePath, currentCommit.hash),
    revisionUri(nextCommit.filePath, nextCommit.hash),
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

  const when = describeDate(commit.date);

  const items: vscode.QuickPickItem[] = [
    {
      label: commit.author ? `${commit.author}, ${when}` : when,
      detail: commit.subject,
      kind: vscode.QuickPickItemKind.Default,
    },
    { label: "", kind: vscode.QuickPickItemKind.Separator },
    { label: "$(clippy) Copy SHA", description: commit.hash },
    { label: "$(globe) Open commit in browser" },
    { label: "$(diff) Open Commit Details", description: "Show all changed files" },
  ];

  const picked = await vscode.window.showQuickPick(items, {
    title: `Commit ${sha}`,
    placeHolder: "Show Revision Commit",
  });

  if (!picked) {
    return;
  }

  if (picked.label.includes("Copy SHA")) {
    await vscode.env.clipboard.writeText(commit.hash);
    vscode.window.showInformationMessage(`Copied ${commit.hash}`);
  } else if (picked.label.includes("in browser")) {
    if (currentGistId) {
      await vscode.env.openExternal(
        vscode.Uri.parse(`https://gist.github.com/${currentGistId}/${commit.hash}`)
      );
      return;
    }
    const remoteUrl = await getRemoteUrl(currentFilePath);
    if (remoteUrl) {
      // Bitbucket uses /commits/<hash>; GitHub, GitLab and Gitea use /commit/.
      const segment = remoteUrl.includes("bitbucket.org") ? "commits" : "commit";
      await vscode.env.openExternal(
        vscode.Uri.parse(`${remoteUrl}/${segment}/${commit.hash}`)
      );
    } else {
      vscode.window.showWarningMessage("No remote URL found.");
    }
  } else if (picked.label.includes("Open Commit Details")) {
    await openCommitDetails(commit);
  }
}

async function openCommitDetails(commit: CommitInfo) {
  // The active editor may have moved on while the quick pick was open.
  const index = currentCommits.indexOf(commit);
  if (index === -1) {
    return;
  }

  const files = currentGistId
    ? await getGistChangedFiles(currentGistId, currentCommits, index)
    : await getChangedFiles(currentFilePath, commit.hash);
  if (files.length === 0) {
    vscode.window.showInformationMessage("No changed files in this commit.");
    return;
  }

  const root = currentGistId ? "" : await getRepoRoot(currentFilePath);
  if (root === undefined) {
    vscode.window.showWarningMessage(
      "Could not resolve the git repository root."
    );
    return;
  }

  // Git names its own parent, while a gist revision's parent is just the next
  // entry in the history — and the very first revision has no parent at all.
  const parent = currentGistId ? currentCommits[index + 1] : undefined;
  const parentRef = currentGistId ? parent?.hash : `${commit.hash}~1`;
  const parentLabel = parentRef
    ? currentGistId
      ? shortSha(parentRef)
      : `${shortSha(commit.hash)}~1`
    : "\u2205";
  const parentUri = (filePath: string) =>
    parentRef ? revisionUri(filePath, parentRef) : emptyUri(filePath);

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
  const filePath = currentGistId ? fileName : path.join(root, fileName);
  const status = picked.description;
  const sha = shortSha(commit.hash);

  let leftUri: vscode.Uri;
  let rightUri: vscode.Uri;
  let title: string;

  if (status === "A") {
    leftUri = emptyUri(filePath);
    rightUri = revisionUri(filePath, commit.hash);
    title = diffTitle(filePath, "\u2205", filePath, sha);
  } else if (status === "D") {
    leftUri = parentUri(filePath);
    rightUri = emptyUri(filePath);
    title = diffTitle(filePath, parentLabel, filePath, sha);
  } else {
    leftUri = parentUri(filePath);
    rightUri = revisionUri(filePath, commit.hash);
    title = diffTitle(filePath, parentLabel, filePath, sha);
  }

  await vscode.commands.executeCommand("vscode.diff", leftUri, rightUri, title);
}

// --- Activation ---

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
    vscode.commands.registerCommand("prevNextRevision.showCommit", showCommit),
    vscode.window.onDidChangeActiveTextEditor(updateContext),
    vscode.window.tabGroups.onDidChangeTabs(() => {
      updateContext(vscode.window.activeTextEditor);
    })
  );

  // Kept out of the push above: registering a scheme throws if something else
  // already claimed it, and that must not take the title bar buttons with it.
  try {
    context.subscriptions.push(
      vscode.workspace.registerTextDocumentContentProvider(
        EMPTY_SCHEME,
        new EmptyContentProvider()
      ),
      vscode.workspace.registerTextDocumentContentProvider(
        GIST_REVISION_SCHEME,
        new GistRevisionContentProvider()
      )
    );
  } catch (error) {
    console.error("prev-next-revision: content provider not registered", error);
  }

  updateContext(vscode.window.activeTextEditor);
}

export function deactivate() {}
