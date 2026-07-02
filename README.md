# Pi Task Tracker

Purpose: a Pi extension package that adds session-scoped task tracking for longer, multi-step agent work.

## Features

- Adds task tools for the agent:
  - `task_list_set`
  - `task_list_add`
  - `task_list_update`
  - `task_list_get`
  - `task_list_clear`
- Shows a live task widget and footer status.
- Keeps task state in the Pi session, so resume and branch navigation keep the right checklist.
- Supports preset-level enablement through `presets.json`.
- Avoids task-list spam by only creating lists for non-trivial work.

## Install

```bash
pi install npm:pi-task-tracker
```

Try without installing:

```bash
pi -e npm:pi-task-tracker
```

Install from GitHub before npm publish:

```bash
pi install git:github.com/aashishd/pi-task-tracker
```

## Commands

- `/tasks` or `/tasks status`: show current task list
- `/tasks adopt`: adopt the latest assistant `Plan:` checklist
- `/tasks clear`: clear current task list
- `/tasks off` / `/tasks on`: disable or enable task tracker for this session
- `/tasks create off` / `/tasks create on`: disable or enable new task-list creation for this session
- `/todos`: alias for `/tasks`

## Checklist threshold

The agent is instructed to create a task list only when it is useful for progress tracking, such as:

- 3+ meaningful steps
- multiple files or phases
- debugging or research loops
- validation passes
- subagent workflows
- explicit user request for progress tracking

It should not create a checklist for simple Q&A, quick explanations, one small edit, or one to two obvious actions.

## Preset config

Add `taskTracker` to a preset in `presets.json`:

```json
{
  "plan": {
    "taskTracker": {
      "enabled": true,
      "create": true,
      "execute": false,
      "autoAdopt": false,
      "promptToAdopt": true,
      "showWidget": true
    }
  },
  "chat": {
    "taskTracker": false
  }
}
```

Options:

- `enabled`: activate task-tracker tools and prompt context for this preset.
- `create`: allow the agent or detected plans to create new task lists and new task items.
- `execute`: allow progress updates with `task_list_update` in this preset.
- `autoAdopt`: adopt detected `Plan:` checklists without asking.
- `promptToAdopt`: ask before adopting detected `Plan:` checklists.
- `showWidget`: show or hide the live checklist widget.

## Attribution

See `NOTICE.md` for upstream attribution to Pi's official `plan-mode` example and its contributors.

## License

MIT
