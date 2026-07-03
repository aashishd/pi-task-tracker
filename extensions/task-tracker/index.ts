/**
 * Pi Task List Extension
 *
 * Claude Code style task list for longer Pi work.
 *
 * Features:
 * - LLM tools for creating, reading, updating, and clearing a task list
 * - TUI widget/status that updates when task tools run
 * - Section headers for same-objective follow-up work
 * - Plan: section fallback adoption for planning responses
 * - Preset-aware enablement through presets.json taskTracker fields
 * - Session overrides through /tasks on/off and /tasks create on/off
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

type TaskStatus = "pending" | "in_progress" | "done" | "blocked" | "skipped";
type TaskTrackerPresetConfig = boolean | Partial<TaskTrackerOptions>;

interface TaskSection {
	id: number;
	title: string;
	createdAt: number;
}

interface TaskItem {
	id: number;
	text: string;
	status: TaskStatus;
	note?: string;
	updatedAt: number;
	sectionId?: number;
}

interface TaskListState {
	active: boolean;
	title?: string;
	sections?: TaskSection[];
	tasks: TaskItem[];
	createdAt?: number;
	updatedAt?: number;
	completedAt?: number;
	source?: "tool" | "detected-plan" | "command" | "legacy-plan-mode";
}

interface TaskTrackerOptions {
	enabled: boolean;
	create: boolean;
	execute: boolean;
	autoAdopt: boolean;
	promptToAdopt: boolean;
	showWidget: boolean;
}

interface TaskTrackerSettings {
	enabledOverride?: boolean;
	createOverride?: boolean;
}

interface PresetWithTaskTracker {
	taskTracker?: TaskTrackerPresetConfig;
}

interface SharedPresetState {
	name: string | null;
	updatedAt: number;
}

interface ToolDetails {
	action: "set" | "add" | "get" | "update" | "clear";
	state: TaskListState;
	error?: string;
}

const TOOL_NAMES = ["task_list_set", "task_list_add", "task_list_update", "task_list_get", "task_list_clear"];
const TERMINAL_STATUSES = new Set<TaskStatus>(["done", "skipped"]);
const MIN_DETECTED_TASKS_TO_PROMPT = 3;
const TASK_TEXT_MAX_CHARS = 100;
const WIDGET_TASK_LIMIT = 8;
const WIDGET_COMPLETED_CONTEXT = 3;

const DEFAULT_OPTIONS: TaskTrackerOptions = {
	enabled: true,
	create: true,
	execute: true,
	autoAdopt: false,
	promptToAdopt: true,
	showWidget: true,
};

const TaskStatusSchema = StringEnum(["pending", "in_progress", "done", "blocked", "skipped"] as const);

function now(): number {
	return Date.now();
}

function cloneState(state: TaskListState): TaskListState {
	return {
		...state,
		sections: state.sections?.map((section) => ({ ...section })),
		tasks: state.tasks.map((task) => ({ ...task })),
	};
}

function emptyState(): TaskListState {
	return { active: false, tasks: [] };
}

function normalizeOptions(value: TaskTrackerPresetConfig | undefined): TaskTrackerOptions {
	if (value === false) {
		return { ...DEFAULT_OPTIONS, enabled: false, create: false, execute: false };
	}
	if (value === true || value === undefined) {
		return { ...DEFAULT_OPTIONS };
	}
	return { ...DEFAULT_OPTIONS, ...value };
}

function mergeOptions(base: TaskTrackerOptions, settings: TaskTrackerSettings): TaskTrackerOptions {
	return {
		...base,
		enabled: settings.enabledOverride ?? base.enabled,
		create: settings.createOverride ?? base.create,
	};
}

function loadPresets(cwd: string): Record<string, PresetWithTaskTracker> {
	const globalPath = join(getAgentDir(), "presets.json");
	const projectPath = join(cwd, CONFIG_DIR_NAME, "presets.json");
	let globalPresets: Record<string, PresetWithTaskTracker> = {};
	let projectPresets: Record<string, PresetWithTaskTracker> = {};

	if (existsSync(globalPath)) {
		try {
			globalPresets = JSON.parse(readFileSync(globalPath, "utf8")) as Record<string, PresetWithTaskTracker>;
		} catch (err) {
			console.error(`task-tracker: failed to read ${globalPath}: ${err}`);
		}
	}

	if (existsSync(projectPath)) {
		try {
			projectPresets = JSON.parse(readFileSync(projectPath, "utf8")) as Record<string, PresetWithTaskTracker>;
		} catch (err) {
			console.error(`task-tracker: failed to read ${projectPath}: ${err}`);
		}
	}

	return { ...globalPresets, ...projectPresets };
}

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
	return message.role === "assistant" && Array.isArray(message.content);
}

function getTextContent(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function cleanTitle(text: string | undefined): string | undefined {
	const cleaned = text?.replace(/\s+/g, " ").trim();
	if (!cleaned) return undefined;
	return cleaned.length > 80 ? `${cleaned.slice(0, 77)}...` : cleaned;
}

function cleanStepText(text: string): string {
	let cleaned = text
		.replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\s+/g, " ")
		.trim();

	if (cleaned.length > TASK_TEXT_MAX_CHARS) {
		cleaned = `${cleaned.slice(0, TASK_TEXT_MAX_CHARS - 3)}...`;
	}
	return cleaned;
}

function extractPlanTasks(message: string): string[] {
	const headerMatch = message.match(/\*{0,2}Plan:\*{0,2}\s*\n/i);
	if (!headerMatch) return [];

	const planSection = message.slice(message.indexOf(headerMatch[0]) + headerMatch[0].length);
	const tasks: string[] = [];
	const numberedPattern = /^\s*(\d+)[.)]\s+\*{0,2}([^\n]+)/gm;

	for (const match of planSection.matchAll(numberedPattern)) {
		const text = cleanStepText(match[2].replace(/\*{1,2}$/, "").trim());
		if (text.length > 5 && !text.startsWith("/") && !text.startsWith("`")) {
			tasks.push(text);
		}
	}
	return tasks;
}

function statusIcon(status: TaskStatus): string {
	switch (status) {
		case "pending":
			return "☐";
		case "in_progress":
			return "◐";
		case "done":
			return "☑";
		case "blocked":
			return "⚠";
		case "skipped":
			return "↷";
	}
}

function taskLine(task: TaskItem): string {
	const note = task.note ? ` - ${task.note}` : "";
	return `${statusIcon(task.status)} #${task.id} [${task.status}] ${task.text}${note}`;
}

function sectionTitleMap(state: TaskListState): Map<number, string> {
	return new Map<number, string>((state.sections ?? []).map((section): [number, string] => [section.id, section.title]));
}

function hasTaskSections(state: TaskListState): boolean {
	return (state.sections?.length ?? 0) > 0 && state.tasks.some((task) => task.sectionId !== undefined);
}

function getWidgetTaskWindow(tasks: TaskItem[]): { tasks: TaskItem[]; hiddenBefore: number; hiddenAfter: number } {
	if (tasks.length <= WIDGET_TASK_LIMIT) {
		return { tasks, hiddenBefore: 0, hiddenAfter: 0 };
	}

	const firstOpenIndex = tasks.findIndex((task) => !TERMINAL_STATUSES.has(task.status));
	const anchorIndex = firstOpenIndex >= 0 ? firstOpenIndex : tasks.length;
	let start = Math.max(0, anchorIndex - WIDGET_COMPLETED_CONTEXT);
	let end = Math.min(tasks.length, start + WIDGET_TASK_LIMIT);

	if (end - start < WIDGET_TASK_LIMIT) {
		start = Math.max(0, end - WIDGET_TASK_LIMIT);
	}

	end = Math.min(tasks.length, start + WIDGET_TASK_LIMIT);
	return {
		tasks: tasks.slice(start, end),
		hiddenBefore: start,
		hiddenAfter: tasks.length - end,
	};
}

function formatTaskList(state: TaskListState): string {
	if (!state.active || state.tasks.length === 0) return "No active task list.";
	const lines: string[] = [];
	const showSections = hasTaskSections(state);
	const titles = sectionTitleMap(state);

	if (!showSections && state.title) lines.push(state.title);

	let lastSectionId: number | undefined;
	for (const task of state.tasks) {
		if (showSections && task.sectionId !== lastSectionId) {
			const title = task.sectionId === undefined ? undefined : titles.get(task.sectionId);
			if (title) {
				if (lines.length > 0) lines.push("");
				lines.push(`▸ ${title}`);
			}
			lastSectionId = task.sectionId;
		}
		lines.push(taskLine(task));
	}

	return lines.join("\n");
}

function createStateFromTasks(params: { title?: string; tasks: string[]; source: TaskListState["source"] }): TaskListState {
	const timestamp = now();
	const title = cleanTitle(params.title);
	const section: TaskSection | undefined = title ? { id: 1, title, createdAt: timestamp } : undefined;
	return {
		active: true,
		title,
		sections: section ? [section] : undefined,
		tasks: params.tasks.map((text, index) => ({
			id: index + 1,
			text: cleanStepText(text),
			status: "pending",
			updatedAt: timestamp,
			sectionId: section?.id,
		})),
		createdAt: timestamp,
		updatedAt: timestamp,
		source: params.source,
	};
}

function isComplete(state: TaskListState): boolean {
	return state.active && state.tasks.length > 0 && state.tasks.every((task) => TERMINAL_STATUSES.has(task.status));
}

function nextTaskId(state: TaskListState): number {
	return Math.max(0, ...state.tasks.map((task) => task.id)) + 1;
}

function nextSectionId(state: TaskListState): number {
	return Math.max(0, ...(state.sections ?? []).map((section) => section.id), ...state.tasks.map((task) => task.sectionId ?? 0)) + 1;
}

function getOrCreateSection(state: TaskListState, title: string | undefined, timestamp: number): TaskSection | undefined {
	const cleaned = cleanTitle(title);
	if (!cleaned) return undefined;

	if (!state.sections) state.sections = [];
	const existing = state.sections.find((section) => section.title.toLowerCase() === cleaned.toLowerCase());
	if (existing) return existing;

	const section = { id: nextSectionId(state), title: cleaned, createdAt: timestamp };
	state.sections.push(section);
	return section;
}

function inferSectionId(state: TaskListState, insertAt: number): number | undefined {
	return state.tasks[insertAt - 1]?.sectionId ?? state.tasks[insertAt]?.sectionId;
}

function getInsertIndex(
	state: TaskListState,
	params: { index?: number; beforeId?: number; afterId?: number },
): number {
	const specified = [params.index !== undefined, params.beforeId !== undefined, params.afterId !== undefined].filter(Boolean).length;
	if (specified > 1) {
		throw new Error("Use only one insertion option: index, beforeId, or afterId.");
	}

	if (params.beforeId !== undefined) {
		const index = state.tasks.findIndex((task) => task.id === params.beforeId);
		if (index < 0) throw new Error(`Task #${params.beforeId} not found.`);
		return index;
	}

	if (params.afterId !== undefined) {
		const index = state.tasks.findIndex((task) => task.id === params.afterId);
		if (index < 0) throw new Error(`Task #${params.afterId} not found.`);
		return index + 1;
	}

	if (params.index !== undefined) {
		if (!Number.isFinite(params.index) || Math.trunc(params.index) !== params.index) {
			throw new Error("index must be an integer.");
		}
		if (params.index < 1 || params.index > state.tasks.length + 1) {
			throw new Error(`index must be between 1 and ${state.tasks.length + 1}.`);
		}
		return params.index - 1;
	}

	return state.tasks.length;
}

function getLatestPresetName(ctx: ExtensionContext): string | undefined {
	const sharedState = (globalThis as typeof globalThis & { __piPresetState?: SharedPresetState }).__piPresetState;
	if (sharedState && Object.prototype.hasOwnProperty.call(sharedState, "name")) {
		return sharedState.name ?? undefined;
	}

	const presetEntry = ctx.sessionManager
		.getEntries()
		.filter((entry: { type: string; customType?: string }) => entry.type === "custom" && entry.customType === "preset-state")
		.pop() as { data?: { name?: string | null } } | undefined;
	return typeof presetEntry?.data?.name === "string" ? presetEntry.data.name : undefined;
}

function findLatestPlanTasks(ctx: ExtensionContext): string[] {
	const entries = [...ctx.sessionManager.getBranch()].reverse();
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message as AgentMessage;
		if (!isAssistantMessage(message)) continue;
		const tasks = extractPlanTasks(getTextContent(message));
		if (tasks.length > 0) return tasks;
	}
	return [];
}

function detailsFromState(action: ToolDetails["action"], state: TaskListState, error?: string): ToolDetails {
	return { action, state: cloneState(state), error };
}

export default function taskTrackerExtension(pi: ExtensionAPI): void {
	let state: TaskListState = emptyState();
	let settings: TaskTrackerSettings = {};
	let presets: Record<string, PresetWithTaskTracker> = {};

	function getOptions(ctx: ExtensionContext): TaskTrackerOptions {
		const presetName = getLatestPresetName(ctx);
		const presetOptions = presetName ? presets[presetName]?.taskTracker : undefined;
		return mergeOptions(normalizeOptions(presetOptions), settings);
	}

	function persistState(source: TaskListState["source"] = state.source): void {
		pi.appendEntry("task-tracker-state", { state: cloneState({ ...state, source }), updatedAt: now() });
	}

	function persistSettings(): void {
		pi.appendEntry("task-tracker-settings", { ...settings, updatedAt: now() });
	}

	function updateUi(ctx: ExtensionContext): void {
		const options = getOptions(ctx);
		if (!options.enabled || !state.active || state.tasks.length === 0) {
			ctx.ui.setStatus("task-tracker", undefined);
			ctx.ui.setWidget("task-tracker", undefined);
			return;
		}

		const completed = state.tasks.filter((task) => TERMINAL_STATUSES.has(task.status)).length;
		const statusText = isComplete(state) ? `☑ ${completed}/${state.tasks.length}` : `📋 ${completed}/${state.tasks.length}`;
		ctx.ui.setStatus("task-tracker", ctx.ui.theme.fg(isComplete(state) ? "success" : "accent", statusText));

		if (!options.showWidget) {
			ctx.ui.setWidget("task-tracker", undefined);
			return;
		}

		const widgetState = cloneState(state);
		ctx.ui.setWidget("task-tracker", (_tui, theme) => ({
			render(width: number): string[] {
				const lines: string[] = [];
				const showSections = hasTaskSections(widgetState);
				const titles = sectionTitleMap(widgetState);
				const window = getWidgetTaskWindow(widgetState.tasks);
				let lastSectionId: number | undefined;

				if (window.hiddenBefore > 0) {
					lines.push(theme.fg("dim", `↑ ${window.hiddenBefore} earlier task(s) hidden`));
				}

				for (const task of window.tasks) {
					if (showSections && task.sectionId !== lastSectionId) {
						const title = task.sectionId === undefined ? undefined : titles.get(task.sectionId);
						if (title) lines.push(theme.fg("accent", `▸ ${title}`));
						lastSectionId = task.sectionId;
					}

					const icon = statusIcon(task.status);
					const prefix = `${icon} #${task.id} `;
					const label = task.note ? `${task.text} (${task.note})` : task.text;
					if (task.status === "done") {
						lines.push(theme.fg("success", prefix) + theme.fg("muted", theme.strikethrough(label)));
						continue;
					}
					if (task.status === "blocked") {
						lines.push(theme.fg("warning", prefix) + theme.fg("muted", label));
						continue;
					}
					if (task.status === "in_progress") {
						lines.push(theme.fg("accent", prefix) + theme.fg("muted", label));
						continue;
					}
					lines.push(theme.fg("muted", `${prefix}${label}`));
				}

				if (window.hiddenAfter > 0) {
					lines.push(theme.fg("dim", `↓ ${window.hiddenAfter} later task(s) hidden`));
				}

				return lines.map((line) => truncateToWidth(` ${line}`, width));
			},
			invalidate() {},
		}));
	}

	function syncTaskTools(ctx: ExtensionContext): void {
		const options = getOptions(ctx);
		const active = pi.getActiveTools();
		const next = options.enabled
			? [...new Set([...active, ...TOOL_NAMES])]
			: active.filter((tool) => !TOOL_NAMES.includes(tool));
		if (next.join("\u0000") !== active.join("\u0000")) {
			pi.setActiveTools(next);
		}
	}

	function setState(nextState: TaskListState, ctx?: ExtensionContext, persist = false): void {
		state = cloneState(nextState);
		if (persist) persistState(state.source);
		if (ctx) updateUi(ctx);
	}

	function clearState(ctx?: ExtensionContext, persist = false): void {
		state = emptyState();
		if (persist) persistState("command");
		if (ctx) updateUi(ctx);
	}

	function reconstructState(ctx: ExtensionContext): void {
		state = emptyState();
		settings = {};

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === "task-tracker-settings") {
				settings = { ...(entry.data as TaskTrackerSettings | undefined) };
				delete (settings as { updatedAt?: number }).updatedAt;
				continue;
			}

			if (entry.type === "custom" && entry.customType === "task-tracker-state") {
				const data = entry.data as { state?: TaskListState } | undefined;
				if (data?.state) state = cloneState(data.state);
				continue;
			}

			if (entry.type === "custom" && entry.customType === "plan-mode") {
				const data = entry.data as { todos?: Array<{ step?: number; text: string; completed: boolean }>; executing?: boolean } | undefined;
				if (!state.active && data?.executing && data.todos && data.todos.length > 0) {
					const timestamp = now();
					state = {
						active: true,
						tasks: data.todos.map((todo, index) => ({
							id: todo.step ?? index + 1,
							text: todo.text,
							status: todo.completed ? "done" : "pending",
							updatedAt: timestamp,
						})),
						createdAt: timestamp,
						updatedAt: timestamp,
						source: "legacy-plan-mode",
					};
				}
				continue;
			}

			if (entry.type !== "message") continue;
			const message = entry.message;
			if (message.role !== "toolResult" || !TOOL_NAMES.includes(message.toolName ?? "")) continue;
			const details = message.details as ToolDetails | undefined;
			if (details?.state) state = cloneState(details.state);
		}
	}

	function ensureEnabledForTool(ctx: ExtensionContext, action: "create" | "execute"): void {
		const options = getOptions(ctx);
		if (!options.enabled) {
			throw new Error("Task tracker is disabled for the active preset or session.");
		}
		if (action === "create" && !options.create) {
			throw new Error("Task list creation is disabled for the active preset or session.");
		}
		if (action === "execute" && !options.execute) {
			throw new Error("Task execution tracking is disabled for the active preset.");
		}
	}

	function buildPromptContext(ctx: ExtensionContext): string | undefined {
		const options = getOptions(ctx);
		if (!options.enabled) return undefined;

		if (state.active && state.tasks.length > 0) {
			const objectiveScopeLine = "Treat the active task list as scoped to the current work objective, not the whole conversation. At each user follow-up, decide whether the request is same-objective, a new objective, or unrelated.\n\nKeep the list for same-objective follow-ups, small adjustments, or questions about the listed work. Use task_list_add only for new work that clearly belongs to the same objective.\n\nFor a new complex objective, use task_list_set to replace the list. For unrelated questions or when tracking is no longer useful, use task_list_clear or answer without touching the list. When unsure, do not append by default.";
			const lifecycleLine = isComplete(state) ? `The active task list is complete. ${objectiveScopeLine}` : objectiveScopeLine;
			const modeLine = options.execute
				? "Work through the active task list. Call task_list_update whenever a task starts, completes, becomes blocked, or is skipped. If a listed task becomes obsolete, mark it skipped with a short note. Ask the user before expanding scope materially."
				: "Use the active task list as planning context only in this preset. You may refine the list with task_list_add or task_list_set, but do not execute tasks unless the user switches to an executable preset or explicitly asks.";
			return `[TASK TRACKER ACTIVE]\n${modeLine}\n${lifecycleLine}\n\nCurrent task list:\n${formatTaskList(state)}`;
		}

		if (!options.create) return undefined;
		return `[TASK TRACKER AVAILABLE]\nBefore creating a task list, first decide whether one is actually useful. Do not create a checklist for simple Q&A, quick explanations, one small edit, or a task that is clearly one or two obvious actions. Create one only when the work is complex enough to benefit from progress tracking, for example 3+ meaningful steps, multiple files or phases, debugging/research loops, validation passes, subagent workflows, or when the user asks for progress tracking. Keep task labels short, ideally 60 to 100 characters, and move details into notes only when needed. If unsure, answer directly or ask a clarifying question instead of creating a checklist. In planning-only presets, create or propose the list but do not execute it.`;
	}

	pi.registerTool({
		name: "task_list_set",
		label: "Task List Set",
		description: "Create or replace the current session task list for longer multi-step work.",
		promptSnippet: "Create or replace the current session task list.",
		promptGuidelines: [
			"Use task_list_set only after deciding the work is complex enough to benefit from progress tracking.",
			"Use task_list_set to replace an active task list when the user's request changes objective, the current list is obsolete, or a completed list should not be extended.",
			"Do not use task_list_set for simple Q&A, quick explanations, one small edit, or one to two obvious actions.",
			"Prefer task_list_set for 3+ meaningful steps, multiple files or phases, debugging/research loops, validation passes, subagent workflows, or explicit user requests for tracking.",
			"Keep task_list_set task labels short, ideally 60 to 100 characters, and move extra detail into follow-up notes only when needed.",
		],
		parameters: Type.Object({
			title: Type.Optional(Type.String({ description: "Short task list title" })),
			tasks: Type.Array(Type.String({ description: "Short actionable task label, ideally 60 to 100 characters" }), {
				description: "Ordered task list items",
			}),
		}),
		prepareArguments(args) {
			if (!args || typeof args !== "object") return args;
			const input = args as { tasks?: unknown; task?: unknown };
			if (typeof input.tasks === "string") return { ...input, tasks: [input.tasks] };
			if (input.tasks === undefined && typeof input.task === "string") return { ...input, tasks: [input.task] };
			return args;
		},
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			ensureEnabledForTool(ctx, "create");
			if (!params.tasks || params.tasks.length === 0) {
				throw new Error("task_list_set requires at least one task.");
			}
			setState(createStateFromTasks({ title: params.title, tasks: params.tasks, source: "tool" }), ctx);
			return {
				content: [{ type: "text" as const, text: `Task list created with ${state.tasks.length} task(s).` }],
				details: detailsFromState("set", state),
			};
		},
		renderCall(args, theme) {
			const count = Array.isArray(args.tasks) ? args.tasks.length : 0;
			return new Text(theme.fg("toolTitle", theme.bold("task_list_set ")) + theme.fg("muted", `${count} task(s)`), 0, 0);
		},
		renderResult(result, _options, theme) {
			const details = result.details as ToolDetails | undefined;
			const count = details?.state.tasks.length ?? 0;
			return new Text(theme.fg("success", "✓ ") + theme.fg("muted", `Task list ready: ${count} task(s)`), 0, 0);
		},
	});

	pi.registerTool({
		name: "task_list_add",
		label: "Task List Add",
		description: "Add one or more newly discovered tasks to the active task list at a specific position.",
		promptSnippet: "Add newly discovered task(s) to the active task list.",
		promptGuidelines: [
			"Use task_list_add when necessary work is discovered that is not represented in the active task list and still belongs to the same objective.",
			"Use task_list_add with sectionTitle when a follow-up or new phase should be grouped under its own task-list header.",
			"Use task_list_add with afterId, beforeId, or index to keep the checklist order accurate.",
			"Do not use task_list_add for unrelated follow-ups or stale lists. Use task_list_set to replace the list, or task_list_clear if tracking is no longer useful.",
			"Do not use task_list_add to expand scope silently. Ask the user first when the new task materially changes scope.",
			"Keep task_list_add task labels short, ideally 60 to 100 characters, and move extra detail into update notes only when needed.",
		],
		parameters: Type.Object({
			tasks: Type.Array(Type.String({ description: "Short actionable task label, ideally 60 to 100 characters" }), {
				description: "One or more tasks to insert",
			}),
			sectionTitle: Type.Optional(Type.String({ description: "Optional section header for these tasks. Use for same-objective follow-ups or phases that need visual grouping." })),
			index: Type.Optional(Type.Number({ description: "1-based insertion position. 1 inserts at the top. Omit to append." })),
			beforeId: Type.Optional(Type.Number({ description: "Insert before this existing task ID" })),
			afterId: Type.Optional(Type.Number({ description: "Insert after this existing task ID" })),
		}),
		prepareArguments(args) {
			if (!args || typeof args !== "object") return args;
			const input = args as { tasks?: unknown; task?: unknown; text?: unknown; section?: unknown; sectionTitle?: unknown };
			let next = input;
			if (input.sectionTitle === undefined && typeof input.section === "string") next = { ...next, sectionTitle: input.section };
			if (typeof next.tasks === "string") return { ...next, tasks: [next.tasks] };
			if (next.tasks === undefined && typeof next.task === "string") return { ...next, tasks: [next.task] };
			if (next.tasks === undefined && typeof next.text === "string") return { ...next, tasks: [next.text] };
			return next;
		},
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			ensureEnabledForTool(ctx, "create");
			if (!state.active || state.tasks.length === 0) throw new Error("No active task list. Use task_list_set first.");
			if (!params.tasks || params.tasks.length === 0) throw new Error("task_list_add requires at least one task.");
			if (isComplete(state) && !cleanTitle(params.sectionTitle)) {
				throw new Error("The active task list is complete. Use task_list_set for a new objective, or provide sectionTitle to extend the same objective with a new section.");
			}

			const insertAt = getInsertIndex(state, params);
			const timestamp = now();
			const section = getOrCreateSection(state, params.sectionTitle, timestamp);
			const sectionId = section?.id ?? inferSectionId(state, insertAt);
			const firstId = nextTaskId(state);
			const additions: TaskItem[] = params.tasks.map((text, offset) => ({
				id: firstId + offset,
				text: cleanStepText(text),
				status: "pending",
				updatedAt: timestamp,
				sectionId,
			}));
			state.tasks.splice(insertAt, 0, ...additions);
			state.updatedAt = timestamp;
			state.completedAt = undefined;
			updateUi(ctx);

			return {
				content: [
					{
						type: "text" as const,
						text: `Added ${additions.length} task(s) at position ${insertAt + 1}. New task IDs: ${additions.map((task) => `#${task.id}`).join(", ")}.${section ? ` Section: ${section.title}.` : ""}`,
					},
				],
				details: detailsFromState("add", state),
			};
		},
		renderCall(args, theme) {
			const count = Array.isArray(args.tasks) ? args.tasks.length : 0;
			const position = args.afterId !== undefined ? `after #${args.afterId}` : args.beforeId !== undefined ? `before #${args.beforeId}` : args.index !== undefined ? `at ${args.index}` : "append";
			const section = typeof args.sectionTitle === "string" && args.sectionTitle.trim() ? `, section ${args.sectionTitle.trim()}` : "";
			return new Text(
				theme.fg("toolTitle", theme.bold("task_list_add ")) +
					theme.fg("muted", `${count} task(s), ${position}${section}`),
				0,
				0,
			);
		},
		renderResult(result, _options, theme) {
			const text = result.content[0];
			const message = text?.type === "text" ? text.text : "Task(s) added.";
			return new Text(theme.fg("success", "✓ ") + theme.fg("muted", message), 0, 0);
		},
	});

	pi.registerTool({
		name: "task_list_update",
		label: "Task List Update",
		description: "Update the status or note for one task in the active task list.",
		promptSnippet: "Update one task status in the active task list.",
		promptGuidelines: [
			"Use task_list_update immediately when starting, completing, blocking, or skipping an active tracked task.",
			"Use task_list_update instead of text-only done markers when a task tracker list is active.",
		],
		parameters: Type.Object({
			id: Type.Number({ description: "Task ID to update" }),
			status: TaskStatusSchema,
			note: Type.Optional(Type.String({ description: "Short status note or blocker reason" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			ensureEnabledForTool(ctx, "execute");
			if (!state.active || state.tasks.length === 0) throw new Error("No active task list.");
			const task = state.tasks.find((item) => item.id === params.id);
			if (!task) throw new Error(`Task #${params.id} not found.`);
			task.status = params.status as TaskStatus;
			task.note = params.note;
			task.updatedAt = now();
			state.updatedAt = task.updatedAt;
			state.completedAt = isComplete(state) ? task.updatedAt : undefined;
			updateUi(ctx);
			const completeText = isComplete(state) ? " All tasks are now complete." : "";
			return {
				content: [
					{
						type: "text" as const,
						text: `Task #${task.id} updated to ${task.status}.${completeText}`,
					},
				],
				details: detailsFromState("update", state),
			};
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("task_list_update ")) +
					theme.fg("accent", `#${args.id}`) +
					" " +
					theme.fg("muted", String(args.status)),
				0,
				0,
			);
		},
		renderResult(result, _options, theme) {
			const text = result.content[0];
			const message = text?.type === "text" ? text.text : "Task updated.";
			return new Text(theme.fg("success", "✓ ") + theme.fg("muted", message), 0, 0);
		},
	});

	pi.registerTool({
		name: "task_list_get",
		label: "Task List Get",
		description: "Read the active task list and statuses.",
		promptSnippet: "Read the active task list and statuses.",
		promptGuidelines: ["Use task_list_get when you need to inspect the current tracked task list."],
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const options = getOptions(ctx);
			if (!options.enabled) throw new Error("Task tracker is disabled for the active preset or session.");
			updateUi(ctx);
			return {
				content: [{ type: "text" as const, text: formatTaskList(state) }],
				details: detailsFromState("get", state),
			};
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("task_list_get")), 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			const details = result.details as ToolDetails | undefined;
			if (!details?.state.active) return new Text(theme.fg("dim", "No active task list"), 0, 0);
			const tasks = expanded ? details.state.tasks : details.state.tasks.slice(0, 6);
			const showSections = hasTaskSections(details.state);
			const titles = sectionTitleMap(details.state);
			let lastSectionId: number | undefined;
			let text = theme.fg("muted", `${details.state.tasks.length} task(s):`);
			for (const task of tasks) {
				if (showSections && task.sectionId !== lastSectionId) {
					const title = task.sectionId === undefined ? undefined : titles.get(task.sectionId);
					if (title) text += `\n${theme.fg("accent", `▸ ${title}`)}`;
					lastSectionId = task.sectionId;
				}
				text += `\n${statusIcon(task.status)} ${theme.fg("accent", `#${task.id}`)} ${theme.fg("muted", task.text)}`;
			}
			if (!expanded && details.state.tasks.length > tasks.length) text += `\n${theme.fg("dim", `... ${details.state.tasks.length - tasks.length} more`)}`;
			return new Text(text, 0, 0);
		},
	});

	pi.registerTool({
		name: "task_list_clear",
		label: "Task List Clear",
		description: "Clear the active task list.",
		promptSnippet: "Clear the active task list.",
		promptGuidelines: ["Use task_list_clear only when the task list is obsolete or the user asks to clear it."],
		parameters: Type.Object({ reason: Type.Optional(Type.String({ description: "Reason for clearing the task list" })) }),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const previousCount = state.tasks.length;
			clearState(ctx);
			return {
				content: [{ type: "text" as const, text: `Cleared ${previousCount} task(s).${params.reason ? ` Reason: ${params.reason}` : ""}` }],
				details: detailsFromState("clear", state),
			};
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("task_list_clear")), 0, 0);
		},
		renderResult(result, _options, theme) {
			const text = result.content[0];
			return new Text(theme.fg("success", "✓ ") + theme.fg("muted", text?.type === "text" ? text.text : "Cleared"), 0, 0);
		},
	});

	async function handleTasksCommand(args: string, ctx: ExtensionContext): Promise<void> {
		const normalized = args.trim().toLowerCase();
		if (["off", "disable", "disabled"].includes(normalized)) {
			settings.enabledOverride = false;
			persistSettings();
			syncTaskTools(ctx);
			updateUi(ctx);
			ctx.ui.notify("Task tracker disabled for this session.", "info");
			return;
		}
		if (["on", "enable", "enabled"].includes(normalized)) {
			settings.enabledOverride = true;
			persistSettings();
			syncTaskTools(ctx);
			updateUi(ctx);
			ctx.ui.notify("Task tracker enabled for this session.", "info");
			return;
		}
		if (["create off", "creation off"].includes(normalized)) {
			settings.createOverride = false;
			persistSettings();
			ctx.ui.notify("Task list creation disabled for this session.", "info");
			return;
		}
		if (["create on", "creation on"].includes(normalized)) {
			settings.createOverride = true;
			persistSettings();
			ctx.ui.notify("Task list creation enabled for this session.", "info");
			return;
		}
		if (["clear", "reset"].includes(normalized)) {
			clearState(ctx, true);
			ctx.ui.notify("Task list cleared.", "info");
			return;
		}
		if (normalized === "adopt") {
			const tasks = findLatestPlanTasks(ctx);
			if (tasks.length === 0) {
				ctx.ui.notify("No Plan: checklist found to adopt.", "warning");
				return;
			}
			setState(createStateFromTasks({ tasks, source: "command" }), ctx, true);
			ctx.ui.notify(`Adopted ${tasks.length} task(s).`, "info");
			return;
		}
		if (normalized === "status" || normalized === "") {
			updateUi(ctx);
			pi.sendMessage({ customType: "task-tracker-view", content: formatTaskList(state), display: true }, { triggerTurn: false });
			return;
		}

		ctx.ui.notify("Usage: /tasks [status|adopt|clear|on|off|create on|create off]", "info");
	}

	pi.registerCommand("tasks", {
		description: "Show or manage the tracked task list",
		handler: async (args, ctx) => handleTasksCommand(args, ctx),
	});

	pi.registerCommand("todos", {
		description: "Alias for /tasks",
		handler: async (args, ctx) => handleTasksCommand(args, ctx),
	});

	pi.on("session_start", async (_event, ctx) => {
		presets = loadPresets(ctx.cwd);
		reconstructState(ctx);
		syncTaskTools(ctx);
		updateUi(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		reconstructState(ctx);
		syncTaskTools(ctx);
		updateUi(ctx);
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return { action: "continue" as const };
		presets = loadPresets(ctx.cwd);
		syncTaskTools(ctx);
		return { action: "continue" as const };
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		presets = loadPresets(ctx.cwd);
		syncTaskTools(ctx);
		const context = buildPromptContext(ctx);
		if (!context) return;
		return {
			message: {
				customType: "task-tracker-context",
				content: context,
				display: false,
			},
		};
	});

	pi.on("agent_end", async (event, ctx) => {
		const options = getOptions(ctx);
		if (!options.enabled || !options.create) return;
		if (state.active && !isComplete(state)) return;

		const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
		const tasks = lastAssistant ? extractPlanTasks(getTextContent(lastAssistant)) : [];
		if (tasks.length < MIN_DETECTED_TASKS_TO_PROMPT) return;

		if (options.autoAdopt || !ctx.hasUI) {
			setState(createStateFromTasks({ tasks, source: "detected-plan" }), ctx, true);
			return;
		}

		if (!options.promptToAdopt) return;
		const adoptLabel = state.active ? "Replace completed task list" : "Adopt task list";
		const choice = await ctx.ui.select("Task tracker detected a Plan: checklist", [
			adoptLabel,
			"Ignore this checklist",
		]);
		if (choice === adoptLabel) {
			setState(createStateFromTasks({ tasks, source: "detected-plan" }), ctx, true);
			ctx.ui.notify(`Adopted ${tasks.length} task(s). Use /tasks to view or clear.`, "info");
		}
	});
}
