# bash-permissions

Asks before Claude runs a dangerous Bash command. The question shows the whole command, never shortened. Above it, a card shows the risk level and a one-sentence explanation of what the command does.

The explanation and a danger score from 1 to 100 come from a model. If the model gives no answer, the mod writes the sentence itself, and the card shows the rule's fixed severity instead of a score. For deletes, that sentence names what would be removed, such as "Deletes 2 items in ~/.claude/session-env with everything inside". The card then also shows the reason Claude gave for the command.

The answers name the rules they switch off. "Allow rm-rf, rm for session" and "Always allow rm-rf, rm" allow every command those rules catch, not only this one. A note under each answer says what it does.

By default it asks for commands that change shared state or cannot be undone, including:

- `git commit`, `git push`, `git reset --hard`, `git clean`
- `gh pr create` and `gh pr edit`
- Graphite (`gt submit`, `gt modify`, `gt sync` and others)
- PlanetScale (`pscale deploy-request`, branch and database deletes, passwords, shells)
- MySQL clients (`mysql`, `mysqldump`, `mysqladmin`)
- Obsidian CLI writes, edits, moves and deletes
- `rm -rf`, `dd`, `mkfs`, `sudo`

Other rules stay quiet unless you turn them on. Anything that does not ask is left to Claude Code's own permission mode.

## Commands

- `/bash-permissions` shows how many rules ask, what is always allowed, what you allowed this session, and whether explanations are on.
- `/bash-permissions rules` lists every rule with its ID, whether it asks, and what it catches.
- `/bash-permissions check <command>` shows which rules match a command and whether each one asks.

## Options

Set these with `/plugin configure bash-permissions@plugins-and-mods-by-xryul`.

| Option | Default | What it does |
| --- | --- | --- |
| `alwaysAllow` | empty | Rule IDs that never ask, comma separated. Choosing "Always allow …" in the question adds the rules it names to this list. |
| `alwaysAsk` | empty | Rule IDs that are off by default but should ask, comma separated. |
| `explain` | on | Asks a model for the explanation and danger score. Off: the mod's own sentence and the rule's severity. |
| `model` | `haiku` | The model alias or ID used for the explanation. |

With `explain` on, each question makes one small model call, which counts towards your usage.

## Install

```
/plugin install bash-permissions --marketplace xRyul/claude-plugins-and-mods-by-xryul
```

## Licence

MIT
