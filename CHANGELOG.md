# Changelog

## Unreleased

- Show Revision Commit now heads its quick pick with the author and when the
  revision landed — "danieledep, 1 month ago (14 August 2026 at 14:34)" — with
  the commit subject beneath it, in place of the short SHA and a raw timestamp
- Replace "Open Commit Details" with "Open commit", which opens every file the
  revision touched in one multi-file diff editor instead of asking which file
- Reorder the actions to Open commit, Open in browser, Copy SHA, and shorten
  displayed SHAs to git's usual 7 characters
- Rename the title bar buttons to "Previous changes", "Show commit details"
  and "Next changes"
- Move the commit into the quick pick's title — "466d69e - danieledep, 1 month
  ago" — so the heading carries the heavier of the two lines and no longer
  looks selectable, with the commit message as a separator above the actions
- Note the host on "Open in browser", e.g. "github.com"

## 0.0.8

- Follow a gist file through a rename, matching it by identical contents since
  a gist records a rename as one file vanishing and another appearing
- Fix the arrows disappearing on a revision whose directory no longer exists,
  which a move between folders leaves behind
- Fix the arrows disappearing on the empty side of a deleted file's diff

## 0.0.7

- Support GistPad gists: the arrows now step through a gist's GitHub revisions,
  skipping the ones that didn't touch the file you're looking at

## 0.0.1

- Initial release
- Previous/next revision arrows in editor title bar
- Commit button with quick pick (copy SHA, open on GitHub, commit details)
- Disabled state for buttons at history boundaries
