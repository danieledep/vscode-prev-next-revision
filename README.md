# Previous/Next Revision

Lightweight VS Code extension that adds revision navigation arrows to the editor title bar.

## Features

Navigate through a file's git history directly from the editor toolbar:

- **Previous Revision** — open a diff with the previous commit that changed this file
- **Next Revision** — open a diff with the next commit (or working copy)
- **Show Commit** — quick pick with copy SHA, open on GitHub, and view all changed files

Buttons are disabled at boundaries (greyed out when there's no older/newer revision).

### GistPad gists

The same arrows work on gists opened with [GistPad](https://marketplace.visualstudio.com/items?itemName=vsls-contrib.gistfs).
Gists are versioned by GitHub rather than by git, so revisions come from the
GitHub API instead of a local repository; revisions that left the current file
untouched are skipped, so the arrows step through that file's own history.

Renames are followed. A gist records one as a file vanishing and another
appearing, so a renamed file is matched by identical contents — the same exact
match git calls R100. A revision that renames *and* edits in one save can't be
matched that way, and navigation stops there.

Public gists work without signing in. Secret gists (and heavy use) need a GitHub
session — the extension reuses the one you already granted, and otherwise puts a
sign-in badge on the Accounts menu.

## Usage

1. Open any file tracked by git
2. The navigation arrows appear in the editor title bar
3. Click the left arrow to step back through history
4. Click the right arrow to step forward
5. Click the commit icon to see commit details

## Development

`dist/` is generated and not checked in, so install first — the F5 build task
needs the local dev dependencies, and without them the extension has no entry
point to load:

```sh
npm install   # then F5 to launch the Extension Development Host
```

## Requirements

- Git must be installed and available in your PATH
- The file must be inside a git repository workspace, or be a gist opened with GistPad
