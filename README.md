# Previous/Next Revision

Lightweight VS Code extension that adds revision navigation arrows to the editor title bar.

## Features

Navigate through a file's git history directly from the editor toolbar:

- **Previous Revision** — open a diff with the previous commit that changed this file
- **Next Revision** — open a diff with the next commit (or working copy)
- **Show Commit** — quick pick with copy SHA, open on GitHub, and view all changed files

Buttons are disabled at boundaries (greyed out when there's no older/newer revision).

## Usage

1. Open any file tracked by git
2. The navigation arrows appear in the editor title bar
3. Click the left arrow to step back through history
4. Click the right arrow to step forward
5. Click the commit icon to see commit details

## Requirements

- Git must be installed and available in your PATH
- The file must be inside a git repository workspace
