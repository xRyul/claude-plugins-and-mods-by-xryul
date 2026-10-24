# prompt-timeline

A pane beside the chat that shows every prompt in the current session, as a tree of every branch a rewind left behind or as a list, with how much of the context window was in use and when you sent it.

- Click a prompt to scroll the transcript to it.
- Use list to see the prompts in the order you sent them, with how long ago, and ctx to show or hide the context column in both views.
- Use find to search the full text of every prompt, in either view: the tree lights each match where it sits and dims the rest, and the list shows only the matches, newest first.
- The pane opens on the tree: every branch a rewind left behind, to continue from one. A rewind to the very first prompt is a branch too, forking off above it. Each prompt is a numbered dot on its branch's line, followed by what its turn did (files changed, commands run, a commit or a push), how much of the context window was in use, and when you sent it. Your own line is in the accent colour, and every other branch has a colour of its own. Click a prompt on another branch to read its last reply and continue from it. Each card, and the tree's last row, copies a `/resume-at` command.
- `/timeline` shows or hides the pane.
- `/resume-at <session-id>:<message-id>` opens a session at one of its messages, from any Claude Code session. `/resume-at <message-id>` does it in the current session.

`/resume-at` points the session itself at the message, the way a rewind or the tree's "continue from here" does, so every branch stays in one session. A session open in another Claude Code window is never written to: it is copied instead, every branch included, and the copy opens at that message. `/resume-at --copy …` always copies. Ids can be shortened to their first characters, as long as they are unique.

The pane remembers whether it was open, and whether ctx is shown, between sessions. Each session opens on the tree.

## Install

```
/plugin install prompt-timeline --marketplace xRyul/claude-plugins-and-mods-by-xryul
```

## Licence

MIT
