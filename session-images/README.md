# session-images

A pane that lists the images of the current session in two groups.

- **Added by you**: every image you pasted into the prompt, including ones from before a compaction.
- **Created by Claude**: image files a tool call wrote or changed, such as a chart a script saved or a screenshot taken with a command. Images Claude only read are left out.

Each row shows the image's time (or date, if it was another day) and its pixel size, newest first. A group shows eight rows until you ask for more. Click a row, or move to it with Tab and press Enter, to open the image in its default app.

The pane opens by itself the first time a session has an image. `/images` opens it again after you close it.

## Opening images

On WSL, a row opens the image in its Windows default app through `explorer.exe`, the same as a double click. Elsewhere it uses `xdg-open`.

## What it misses

- Screenshots a tool returns without saving them to a file.
- File paths that contain spaces.
- Images Claude created earlier in a session that a compaction has removed from the conversation.

## Install

```
/plugin install session-images --marketplace xRyul/claude-plugins-and-mods-by-xryul
```

## Licence

MIT
