import * as vscode from "vscode";
import { CommitInfo } from "./git";

/** GistPad's virtual file system scheme (vsls-contrib.gistfs). */
const GISTPAD_SCHEME = "gist";

/** Our own read-only scheme for a gist file as of a given revision. */
export const GIST_REVISION_SCHEME = "pnr-gist";

const API = "https://api.github.com";
const HISTORY_TTL = 30_000;
const MAX_CACHED_REVISIONS = 100;

interface GistRevision {
  version: string;
  committed_at: string;
  user?: { login?: string } | null;
  change_status?: { additions?: number; deletions?: number };
}

type GistFiles = Record<string, string>;

interface GistResponse {
  history?: GistRevision[];
  files?: Record<
    string,
    { content?: string; truncated?: boolean; raw_url?: string }
  >;
}

// --- URIs ---

/**
 * GistPad renders a gist file whose name encodes a directory ("docs---api.md")
 * as a nested path, replacing the first separator only. Mirror that both ways
 * so we can move between what the editor shows and the real gist file name.
 */
export function getGistFileName(uri: vscode.Uri): string {
  return uri.path.substring(1).replace("/", "---");
}

export function gistFileUri(gistId: string, fileName: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: GISTPAD_SCHEME,
    authority: gistId,
    path: `/${fileName.replace("---", "/")}`,
  });
}

export function gistRevisionUri(
  gistId: string,
  fileName: string,
  version: string
): vscode.Uri {
  return vscode.Uri.from({
    scheme: GIST_REVISION_SCHEME,
    authority: gistId,
    path: `/${fileName}`,
    query: version,
  });
}

export function isGistScheme(scheme: string): boolean {
  return scheme === GISTPAD_SCHEME || scheme === GIST_REVISION_SCHEME;
}

/** The gist a URI belongs to, or undefined if it isn't a gist URI at all. */
export function getGistId(uri: vscode.Uri): string | undefined {
  return isGistScheme(uri.scheme) ? uri.authority : undefined;
}

/** The revision a URI is pinned to, or undefined for the live gist file. */
export function getGistRevisionFromUri(uri: vscode.Uri): string | undefined {
  return uri.scheme === GIST_REVISION_SCHEME ? uri.query : undefined;
}

// --- GitHub API ---

let session: Promise<vscode.AuthenticationSession | undefined> | undefined;
let promptedSession:
  | Promise<vscode.AuthenticationSession | undefined>
  | undefined;

async function getSession(scopes: string[], silent: boolean) {
  try {
    return await vscode.authentication.getSession("github", scopes, { silent });
  } catch {
    return undefined;
  }
}

/**
 * Reuse a GitHub session the user has already granted — GistPad asks for
 * ["gist", "repo"], so try that pair too before giving up. Prompting only ever
 * puts a badge on the Accounts menu, and is reserved for the case where an
 * anonymous read failed (a secret gist, or an exhausted rate limit).
 */
async function getToken(prompt = false): Promise<string | undefined> {
  session ??= getSession(["gist"], true).then(
    (s) => s ?? getSession(["gist", "repo"], true)
  );

  let authenticated = await session;
  if (!authenticated && prompt) {
    promptedSession ??= getSession(["gist"], false);
    authenticated = await promptedSession;
  }
  return authenticated?.accessToken;
}

async function api<T>(path: string): Promise<T | undefined> {
  const send = (token: string | undefined) =>
    fetch(`${API}${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });

  try {
    const token = await getToken();
    let response = await send(token);

    if (!token && [401, 403, 404].includes(response.status)) {
      const prompted = await getToken(true);
      if (prompted) {
        response = await send(prompted);
      }
    }

    return response.ok ? ((await response.json()) as T) : undefined;
  } catch {
    return undefined;
  }
}

// --- Revision history ---

const historyCache = new Map<
  string,
  { fetchedAt: number; revisions: GistRevision[] }
>();

/**
 * The gist's revisions, newest first, shaped like a git log so that the rest of
 * the extension can treat them the same way. Revisions are gist-wide, so every
 * entry carries the file we're currently looking at.
 */
export async function getGistLog(
  gistId: string,
  fileName: string
): Promise<CommitInfo[]> {
  const cached = historyCache.get(gistId);
  let revisions = cached?.revisions ?? [];

  if (!cached || Date.now() - cached.fetchedAt > HISTORY_TTL) {
    const gist = await api<GistResponse>(`/gists/${gistId}`);
    // Keep what we already had if the refresh failed, rather than losing it.
    revisions = gist?.history ?? revisions;
    historyCache.set(gistId, { fetchedAt: Date.now(), revisions });
  }

  return revisions.map((revision, index) => {
    const { additions = 0, deletions = 0 } = revision.change_status ?? {};
    return {
      hash: revision.version,
      subject: `Revision ${revisions.length - index} (+${additions} \u2212${deletions})`,
      date: revision.committed_at,
      // Anonymous gists carry no user.
      author: revision.user?.login ?? "",
      filePath: fileName,
    };
  });
}

// --- Revision contents ---

const filesCache = new Map<string, Promise<GistFiles | undefined>>();

async function loadFiles(
  gistId: string,
  version: string
): Promise<GistFiles | undefined> {
  const gist = await api<GistResponse>(`/gists/${gistId}/${version}`);
  if (!gist?.files) {
    return undefined;
  }

  const files: GistFiles = {};
  for (const [name, file] of Object.entries(gist.files)) {
    // Files over 1MB come back truncated, with a permalink to the full blob.
    files[name] =
      file.truncated && file.raw_url
        ? await fetch(file.raw_url)
            .then((r) => (r.ok ? r.text() : ""))
            .catch(() => "")
        : (file.content ?? "");
  }
  return files;
}

/** Revisions are immutable, so cache them — oldest out once the cache is full. */
async function getFiles(gistId: string, version: string) {
  const key = `${gistId}/${version}`;
  const pending = filesCache.get(key) ?? loadFiles(gistId, version);
  filesCache.set(key, pending);

  const oldest = filesCache.keys().next().value;
  if (filesCache.size > MAX_CACHED_REVISIONS && oldest !== undefined) {
    filesCache.delete(oldest);
  }

  const files = await pending;
  if (!files) {
    filesCache.delete(key);
  }
  return files;
}

/** The file's contents at a revision, or undefined if it didn't exist yet. */
async function getContent(gistId: string, version: string, fileName: string) {
  return (await getFiles(gistId, version))?.[fileName];
}

/**
 * The name this file goes by at an adjacent revision. A gist has no notion of a
 * rename — it records one as a file disappearing and another appearing — so a
 * file that is gone from one side and new on the other, with byte-identical
 * contents, is the same file under its other name. That is git's exact (R100)
 * rename detection, and it costs no extra requests because both revisions are
 * already cached.
 */
async function followName(
  gistId: string,
  revisions: CommitInfo[],
  from: number,
  to: number,
  fileName: string
): Promise<string> {
  const target = revisions[to]
    ? await getFiles(gistId, revisions[to].hash)
    : undefined;
  if (!target || fileName in target) {
    return fileName;
  }

  const source = revisions[from]
    ? ((await getFiles(gistId, revisions[from].hash)) ?? {})
    : {};
  const content = source[fileName];
  if (content === undefined) {
    return fileName;
  }

  const renamed = Object.keys(target).find(
    (name) => !(name in source) && target[name] === content
  );
  return renamed ?? fileName;
}

/**
 * Gist revisions span the whole gist, so step over the ones that left this file
 * alone, following it through any rename on the way. Walking outwards stops at
 * the revision that introduced the file, which keeps the number of lookups
 * small even for a long-lived gist.
 *
 * The names resolved along the way are written back onto `revisions`, so the
 * caller can address both the revision it lands on and the one before it.
 */
export async function findChangedRevision(
  gistId: string,
  fileName: string,
  revisions: CommitInfo[],
  from: number,
  direction: 1 | -1
): Promise<number | undefined> {
  // `fileName` is the name as of the revision being stepped away from, which
  // sits one place back along `direction` (or is the live file, which matches
  // the newest revision).
  let name = fileName;
  let previousIndex = from - direction;

  for (let i = from; i >= 0 && i < revisions.length; i += direction) {
    name = await followName(gistId, revisions, previousIndex, i, name);
    previousIndex = i;

    const content = await getContent(gistId, revisions[i].hash, name);
    const olderName = await followName(gistId, revisions, i, i + 1, name);
    const previous =
      i + 1 < revisions.length
        ? await getContent(gistId, revisions[i + 1].hash, olderName)
        : undefined;

    if (content !== previous) {
      revisions[i].filePath = name;
      if (revisions[i + 1]) {
        revisions[i + 1].filePath = olderName;
      }
      return i;
    }
    if (content === undefined) {
      break;
    }
  }
  return undefined;
}

/** The files a revision changed, compared against the revision before it. */
export async function getGistChangedFiles(
  gistId: string,
  revisions: CommitInfo[],
  index: number
): Promise<{ status: string; file: string }[]> {
  const current = (await getFiles(gistId, revisions[index].hash)) ?? {};
  const previous = revisions[index + 1]
    ? ((await getFiles(gistId, revisions[index + 1].hash)) ?? {})
    : {};

  const names = new Set([...Object.keys(current), ...Object.keys(previous)]);
  return [...names]
    .sort()
    .map((file) => {
      if (!(file in previous)) {
        return { status: "A", file };
      }
      if (!(file in current)) {
        return { status: "D", file };
      }
      return current[file] === previous[file]
        ? undefined
        : { status: "M", file };
    })
    .filter((entry): entry is { status: string; file: string } => !!entry);
}

// --- Content provider ---

export class GistRevisionContentProvider
  implements vscode.TextDocumentContentProvider
{
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const gistId = uri.authority;
    const version = uri.query;
    const fileName = uri.path.substring(1);
    return (await getContent(gistId, version, fileName)) ?? "";
  }
}
