# Notice

Purpose: upstream attribution for the Pi Task Tracker extension.

## Upstream inspiration

This extension was inspired by Pi's official `plan-mode` example extension, distributed with `@earendil-works/pi-coding-agent`.

The Pi project is authored by Mario Zechner / Earendil Works and is licensed under MIT. The current upstream repository is `earendil-works/pi`.

The `plan-mode` example's explicit step tracking and progress widget were enhanced by `@ferologics` in `badlogic/pi-mono#694`.

## This package

This package refactors the task-list idea into a standalone Pi task tracker. It uses Pi tool calls such as `task_list_set`, `task_list_add`, and `task_list_update` instead of text markers like `[DONE:n]`.
