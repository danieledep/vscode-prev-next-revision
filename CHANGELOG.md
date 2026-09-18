# Changelog

## 0.0.7

- Support GistPad gists: the arrows now step through a gist's GitHub revisions,
  skipping the ones that didn't touch the file you're looking at, and following
  the file through a rename
- Fix the arrows disappearing on a revision whose directory no longer exists,
  and on the empty side of a deleted file's diff

## 0.0.1

- Initial release
- Previous/next revision arrows in editor title bar
- Commit button with quick pick (copy SHA, open on GitHub, commit details)
- Disabled state for buttons at history boundaries
