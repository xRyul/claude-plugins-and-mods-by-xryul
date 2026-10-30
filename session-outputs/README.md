# session-outputs

An Outputs pane that lists what the current session produced, in four groups.

![The Outputs pane beside the Timeline tab: a design Artifact at version 12, two documents, and the session's images, yours marked with a square and Claude's with a diamond, above the keys that act on the selected row](docs/outputs-pane.png)

- **Artifacts**: the claude.ai Artifacts Claude published (designs, docs, slides, dashboards, pages), each with its kind, when it was last published and its version.
- **Changes**: every file Claude changed with its Edit, Write or NotebookEdit tools, of any type, with the lines it has gained (`+12`, green) and lost (`-3`, red) since the session first changed it, or `unchanged` once it is back as it was. A command that later rewrites one of these files, such as a formatter or `git checkout`, updates its counts. A changed file is listed here and not under Files or Images.
- **Files**: documents a tool call wrote or changed: `.pdf`, `.docx`, `.pptx`, `.xlsx`, `.csv`, `.md`, `.html` and their kin, each with its line count, or its size for a binary file. An Artifact's own source files are left out: its row stands for them.
- **Images**: the images you pasted into the prompt (■), including ones from before a compaction, and the image files a tool call wrote or changed (◆), such as a chart a script saved or a screenshot taken with a command. Images Claude only read are left out.

Each group is newest first, shows five rows until you ask for more, and is hidden while it is empty. Click a row, or move to it with Tab and press Enter, to open it: a file in its default app, an Artifact in the browser, a change as a diff in VS Code. The row you last opened or moved to is highlighted, and the keys at the foot of the pane act on it:

- `c` copies its link, or its path.
- `s` shows it in its folder: the file selected in Explorer on WSL, or the folder an Artifact's files are kept in.

The pane opens by itself the first time a session has something to list. `/session-outputs` opens it again after you close it.

## Opening things

On WSL, a row opens through `explorer.exe`, the same as a double click: a file in its Windows default app, a link in the default browser. Elsewhere it uses `xdg-open`.

A change opens with `code --diff`, so VS Code's `code` command has to be on your `PATH`. The left side is a copy of the file from before the session first changed it, which the pane keeps under `$TMPDIR/claude-session-outputs/<session id>/` (or `/tmp/...`) at the file's own path, so the tab is titled with the file's name. The right side is the file as it is now.

## What it misses

- Screenshots a tool returns without saving them to a file.
- A path with spaces that a call names without quotes around it, such as one a script prints.
- A file a script writes when the call that runs the script never names it, such as a path the script builds from parts.
- Files Claude created earlier in a session that a compaction has removed from the conversation.
- The publish time of an Artifact the pane only learns of when it loads midway through a session: those show the time it loaded.
- Docs made through the Claude Docs connector are matched by the link in its answer, which has not been checked against a real one.
- Changes a command makes, such as `sed -i` or a script, to a file Claude never changed with its Edit, Write or NotebookEdit tools. A command's changes to a file before Claude's first edit to it count as part of how it was before.
- A change whose earlier content was too large for the tool to record, such as a Write over a very large file.
- New counts for a changed file that grows past 2 MB or is deleted: it keeps the counts it last had.
- An exact count where more than 1,000 lines of one file changed: past that, the counts are how many lines each side has that the other lacks, so a moved line is not counted. A missing newline at the end is not counted as a change either.
- The diff of a change whose copy the temporary folder lost mid-session: the pane says the copy was removed.

## Install

```
/plugin install session-outputs --marketplace xRyul/claude-plugins-and-mods-by-xryul
```

## Licence

MIT
