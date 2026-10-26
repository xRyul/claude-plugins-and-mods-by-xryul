# Claude Code plugins and mods by xRyul

A Claude Code marketplace with four plugins. Install only the ones you want.

| Plugin | What it does |
| --- | --- |
| [dracula-theme-mod](./dracula-theme-mod) | Dracula transcript styling: tool call cards, coloured status lines, inline code pills and no dots |
| [bash-permissions](./bash-permissions) | Asks before dangerous Bash commands, showing the whole command, a one-sentence explanation and a danger score |
| [prompt-timeline](./prompt-timeline) | A pane of this session's prompts, opening on a tree of every rewind or fork branch with each turn's context usage; click one to jump to it or continue from it, or list and search them |
| [session-images](./session-images) | A pane of the images you pasted and the image files Claude created in this session; click one to open it in the default app |

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install prompt-timeline --marketplace xRyul/claude-plugins-and-mods-by-xryul
```

Answer `y` to add the marketplace the first time, then choose a scope. Swap `prompt-timeline` for `dracula-theme-mod`, `bash-permissions` or `session-images` to install the others.

From a shell:

```
claude plugin install prompt-timeline --marketplace xRyul/claude-plugins-and-mods-by-xryul
```

In the desktop app: click + next to the prompt box, then Plugins, Add marketplace with `xRyul/claude-plugins-and-mods-by-xryul`, then Add plugin.

Once the marketplace is added, each plugin's ID is `<plugin>@plugins-and-mods-by-xryul`.

## Update

```
claude plugin marketplace update plugins-and-mods-by-xryul
claude plugin update prompt-timeline@plugins-and-mods-by-xryul
```

Then run `/reload-plugins` in an open session.

## Developing

Each plugin is a mod: a `hooks/register.tsx` module that uses Claude Code's plugin API. Check one with `claude plugin validate <folder>` and run its tests with `claude plugin test <folder>`.

## Licence

MIT. See [LICENSE](./LICENSE).
