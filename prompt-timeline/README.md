# prompt-timeline

A pane beside the chat that lists every prompt in the current session, with how long ago you sent it and how much of the context window was in use.

- Click a prompt to scroll the transcript to it.
- Use find to search the full text of every prompt.
- Use tree to see every branch a rewind left behind, and continue from one. A rewind to the very first prompt is a branch too, forking off above it. Each prompt is a numbered dot on its branch's line, followed by what its turn did (files changed, commands run, a commit or a push) and when you sent it. Your own line is in the accent colour, and every other branch has a colour of its own. Click a prompt on another branch to read its last reply and continue from it. Each card, and the tree's last row, copies a `/resume-at` command.
- `/timeline` shows or hides the pane.
- `/resume-at <session-id>:<message-id>` opens a session at one of its messages, from any Claude Code session. `/resume-at <message-id>` does it in the current session.

`/resume-at` points the session itself at the message, the way a rewind or the tree's "continue from here" does, so every branch stays in one session. A session open in another Claude Code window is never written to: it is copied instead, every branch included, and the copy opens at that message. `/resume-at --copy …` always copies. Ids can be shortened to their first characters, as long as they are unique.

The pane remembers whether it was open, and which views you chose, between sessions.

## Install

```
/plugin install prompt-timeline --marketplace xRyul/claude-plugins-and-mods-by-xryul
```

## Licence

MIT
