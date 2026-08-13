import { Menu, Notice, TextFileView, WorkspaceLeaf } from "obsidian";
import {
	DAY_INITIALS,
	DAY_NAMES,
	EventItem,
	HabitRow,
	Meeting,
	Task,
	TimeRow,
	VIEW_TYPE_BULLET,
	WeekData,
	emptyWeek,
	uid,
} from "./types";
import { parseNote, readExtraFrontmatter, serializeNote } from "./serialize";
import { InkLayer, InkMode } from "./inklayer";
import { addDays, parseISODate } from "./date";
import { bulletDot, bulletIcon } from "./icons";
import type BulletPlugin from "./main";

const PROJECT_COLORS = [
	"#c9a227",
	"#6fa8dc",
	"#8fbf7f",
	"#d98d6a",
	"#a58fd0",
	"#7fc7c0",
	"#d07f9e",
];

const PEN_WIDTH_STEPS = [1.4, 2.4, 4, 6.5];

/** Dot radius shown on each stroke-width button, in the icon's 24x24 space. */
const PEN_WIDTH_RADII = [2.5, 4, 6, 8.5];

/** Zoom steps for the toolbar control, as percentages. */
export const SCALE_STEPS = [70, 80, 90, 100, 110, 125, 140, 160, 180, 200];

/** However fast edits arrive, never leave one unwritten longer than this. */
const SAVE_MAX_WAIT = 8000;

export class BulletView extends TextFileView {
	plugin: BulletPlugin;
	model: WeekData = emptyWeek();

	private extraFrontmatter: string[] = [];
	private ink: InkLayer | null = null;

	/** Exposed for the diagnostics command. */
	get inkLayer(): InkLayer | null {
		return this.ink;
	}

	private scrollEl: HTMLElement | null = null;
	private pageEl: HTMLElement | null = null;
	private toolbarEl: HTMLElement | null = null;
	private inkBarEl: HTMLElement | null = null;
	private titleEl: HTMLElement | null = null;

	private hosts: Partial<Record<
		"tasks" | "meetings" | "events" | "habits" | "time" | "notes",
		HTMLElement
	>> = {};

	private penColor: string;
	private penWidth: number;
	private mode: InkMode = "off";
	private notesOpen = false;
	private zoomValueEl: HTMLElement | null = null;

	/** What we last handed to disk, so an echoed save costs no work. */
	private lastSerialized = "";
	private saveTimer = 0;
	private savePendingSince = 0;

	constructor(leaf: WorkspaceLeaf, plugin: BulletPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.penColor = plugin.settings.penColors[0] ?? "#e8eaee";
		this.penWidth = plugin.settings.penWidth;
	}

	getViewType(): string {
		return VIEW_TYPE_BULLET;
	}

	getDisplayText(): string {
		return this.file?.basename ?? "Bullet";
	}

	getIcon(): string {
		return "pencil";
	}

	// -- TextFileView contract ---------------------------------------------

	getViewData(): string {
		if (this.ink) this.model.ink = this.ink.getStrokes();
		this.lastSerialized = serializeNote(
			this.model,
			this.extraFrontmatter,
			this.plugin.settings.compactInk
		);
		return this.lastSerialized;
	}

	setViewData(data: string, clear: boolean): void {
		if (clear) this.clear();

		// A save round-trips through here. Compare against what we last wrote
		// rather than re-serialising: with a page full of ink that comparison
		// was doing the expensive work twice on every stroke.
		if (!clear && data === this.lastSerialized) return;

		this.extraFrontmatter = readExtraFrontmatter(data);
		this.model = parseNote(data);
		this.applyDefaults();
		this.render();
	}

	clear(): void {
		this.model = emptyWeek();
		this.extraFrontmatter = [];
		this.contentEl.empty();
		this.hosts = {};
	}

	async onOpen(): Promise<void> {
		this.addAction("file-text", "Open as markdown", () => {
			this.plugin.openAsMarkdown(this.leaf);
		});
	}

	async onClose(): Promise<void> {
		this.flushSave();
		this.ink?.destroy();
		this.ink = null;
	}

	/** Seed empty sections from settings so a fresh page is not blank. */
	private applyDefaults(): void {
		const s = this.plugin.settings;
		if (this.model.habits.length === 0) {
			this.model.habits = s.habits.map((name) => ({
				name,
				cells: ["", "", "", "", "", "", ""],
			}));
		}
		if (this.model.time.length === 0) {
			this.model.time = s.projects.map((project) => ({
				project,
				blocks: [0, 0, 0, 0, 0, 0, 0],
			}));
			this.model.timeLabel = s.timeLabel;
		}
	}

	/**
	 * Coalesce writes. Ink waits longer than typing: a stroke ends every time
	 * the pen lifts, and serialising the page between letters is what made
	 * handwriting feel like it was stalling.
	 */
	private scheduleSave(delay: number): void {
		const now = Date.now();
		if (!this.savePendingSince) this.savePendingSince = now;

		// Debouncing alone would let a long unbroken run of writing defer the
		// save forever, so cap how long an edit may sit unwritten.
		const remaining = Math.max(0, this.savePendingSince + SAVE_MAX_WAIT - now);
		window.clearTimeout(this.saveTimer);
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = 0;
			// Never serialise the page mid-stroke; wait for the pen to lift.
			if (this.ink?.isDrawing()) {
				this.scheduleSave(400);
				return;
			}
			this.savePendingSince = 0;
			this.requestSave();
		}, Math.min(delay, remaining));
	}

	private touch(): void {
		this.scheduleSave(500);
	}

	private touchInk(): void {
		this.scheduleSave(1400);
	}

	private flushSave(): void {
		if (!this.saveTimer) return;
		window.clearTimeout(this.saveTimer);
		this.saveTimer = 0;
		this.savePendingSince = 0;
		this.requestSave();
	}

	refreshTheme(): void {
		this.contentEl.toggleClass(
			"bullet-own-theme",
			!this.plugin.settings.useThemeColors
		);
		this.applyScale();
		this.ink?.setMaxDpr(this.plugin.settings.maxInkDpr);
	}

	/** The whole page is sized off this one number. */
	applyScale(): void {
		const scale = this.plugin.settings.uiScale / 100;
		this.contentEl.style.setProperty("--bl-scale", String(scale));
		this.zoomValueEl?.setText(`${this.plugin.settings.uiScale}%`);
	}

	private async setScale(percent: number): Promise<void> {
		const clamped = Math.max(50, Math.min(250, Math.round(percent)));
		this.plugin.settings.uiScale = clamped;
		this.applyScale();
		await this.plugin.saveSettings();
	}

	private stepScale(direction: 1 | -1): void {
		const current = this.plugin.settings.uiScale;
		const steps = SCALE_STEPS;
		const next =
			direction > 0
				? steps.find((v) => v > current) ?? steps[steps.length - 1]
				: [...steps].reverse().find((v) => v < current) ?? steps[0];
		void this.setScale(next);
	}

	// -- rendering ---------------------------------------------------------

	private render(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass("bullet-view");
		this.refreshTheme();

		this.ink?.destroy();
		this.ink = null;

		this.zoomValueEl = null;
		this.toolbarEl = root.createDiv({ cls: "bl-toolbar" });
		this.renderToolbar(this.toolbarEl);

		this.scrollEl = root.createDiv({ cls: "bl-scroll" });
		this.pageEl = this.scrollEl.createDiv({ cls: "bl-page" });

		const grid = this.pageEl.createDiv({ cls: "bl-grid" });

		const tasksCard = this.card(grid, "Tasks", "bl-area-tasks");
		this.hosts.tasks = tasksCard.body;
		this.renderTasks();

		const meetingsCard = this.card(grid, "Meetings", "bl-area-meetings");
		this.hosts.meetings = meetingsCard.body;
		this.renderMeetings();

		const trackersCard = this.card(grid, "Trackers", "bl-area-trackers");
		this.hosts.habits = trackersCard.body;
		this.renderTrackers();

		const eventsCard = this.card(grid, "Events", "bl-area-events");
		this.hosts.events = eventsCard.body;
		this.renderEvents();

		// Notes sits outside the 2x2 grid as a strip that stays folded away,
		// so the four panels of the paper spread keep the whole screen.
		this.renderNotes(this.pageEl);

		this.setupInk();
	}

	private renderToolbar(bar: HTMLElement): void {
		const left = bar.createDiv({ cls: "bl-toolbar-group" });

		this.iconButton(left, "chevron-left", "Previous week", () =>
			this.stepWeek(-1)
		);
		this.titleEl = left.createDiv({ cls: "bl-week-title", text: this.model.title });
		this.iconButton(left, "chevron-right", "Next week", () => this.stepWeek(1));
		this.iconButton(left, "calendar", "This week", () =>
			this.plugin.openWeekFor(new Date())
		);

		const right = bar.createDiv({ cls: "bl-toolbar-group bl-toolbar-right" });

		const zoom = right.createDiv({ cls: "bl-zoom" });
		this.iconButton(zoom, "minus", "Smaller", () => this.stepScale(-1));
		this.zoomValueEl = zoom.createEl("button", {
			cls: "bl-zoom-value",
			text: `${this.plugin.settings.uiScale}%`,
		});
		this.zoomValueEl.setAttr("aria-label", "Reset size to 100%");
		this.zoomValueEl.onclick = () => void this.setScale(100);
		this.iconButton(zoom, "plus", "Larger", () => this.stepScale(1));

		const typeBtn = right.createEl("button", { cls: "bl-mode-btn" });
		bulletIcon(typeBtn.createSpan(), "type");
		typeBtn.createSpan({ text: "Type" });

		const drawBtn = right.createEl("button", { cls: "bl-mode-btn" });
		bulletIcon(drawBtn.createSpan(), "pen");
		drawBtn.createSpan({ text: "Draw" });

		const syncModeButtons = () => {
			typeBtn.toggleClass("is-active", this.mode === "off");
			drawBtn.toggleClass("is-active", this.mode !== "off");
			this.inkBarEl?.toggleClass("is-visible", this.mode !== "off");
		};

		typeBtn.onclick = () => {
			this.setMode("off");
			syncModeButtons();
		};
		drawBtn.onclick = () => {
			this.setMode(this.mode === "off" ? "draw" : this.mode);
			syncModeButtons();
		};

		this.inkBarEl = bar.createDiv({ cls: "bl-inkbar" });
		this.renderInkBar(this.inkBarEl, syncModeButtons);
		syncModeButtons();
	}

	private renderInkBar(bar: HTMLElement, syncModeButtons: () => void): void {
		const swatches = bar.createDiv({ cls: "bl-swatches" });
		const paintSwatches = () => {
			swatches.empty();
			for (const color of this.plugin.settings.penColors) {
				const dot = swatches.createEl("button", { cls: "bl-swatch" });
				dot.style.setProperty("--bl-swatch", color);
				dot.toggleClass("is-active", color === this.penColor && this.mode === "draw");
				dot.setAttr("aria-label", color);
				dot.onclick = () => {
					this.penColor = color;
					this.setMode("draw");
					paintSwatches();
					syncModeButtons();
				};
			}
		};
		paintSwatches();

		const widths = bar.createDiv({ cls: "bl-widths" });
		const paintWidths = () => {
			widths.empty();
			PEN_WIDTH_STEPS.forEach((w, index) => {
				const btn = widths.createEl("button", { cls: "bl-width" });
				bulletDot(btn.createSpan({ cls: "bl-width-dot" }), PEN_WIDTH_RADII[index]);
				btn.toggleClass("is-active", Math.abs(w - this.penWidth) < 0.01);
				btn.setAttr("aria-label", `Pen width ${w}`);
				btn.onclick = () => {
					this.penWidth = w;
					this.ink?.setOptions({ width: w });
					this.setMode("draw");
					paintWidths();
					paintSwatches();
					syncModeButtons();
				};
			});
		};
		paintWidths();

		const tools = bar.createDiv({ cls: "bl-inktools" });
		const eraserBtn = this.iconButton(tools, "eraser", "Eraser", () => {
			this.setMode(this.mode === "erase" ? "draw" : "erase");
			eraserBtn.toggleClass("is-active", this.mode === "erase");
			paintSwatches();
			syncModeButtons();
		});
		this.iconButton(tools, "undo", "Undo stroke", () => this.ink?.undo());
		this.iconButton(tools, "redo", "Redo stroke", () => this.ink?.redo());
		this.iconButton(tools, "trash", "Clear all ink", () => {
			if (!this.ink?.canUndo()) return;
			this.ink.clear();
			new Notice("Ink cleared — undo restores it");
		});
	}

	private setupInk(): void {
		if (!this.pageEl) return;
		this.ink = new InkLayer(this.pageEl, {
			fingerDraw: this.plugin.settings.fingerDraw,
			color: this.penColor,
			width: this.penWidth,
			maxDpr: this.plugin.settings.maxInkDpr,
			onChange: () => this.touchInk(),
		});
		this.ink.setStrokes(this.model.ink);
		this.ink.observe(this.pageEl, this.scrollEl);
		this.ink.setMode(this.mode);
	}

	private setMode(mode: InkMode): void {
		this.mode = mode;
		this.ink?.setOptions({
			color: this.penColor,
			width: this.penWidth,
			fingerDraw: this.plugin.settings.fingerDraw,
		});
		this.ink?.setMode(mode);
		this.pageEl?.toggleClass("is-inking", mode !== "off");

		// iPadOS Scribble engages over editable fields and delays pen input
		// while it decides whether you are writing into one. Making the panels
		// inert while drawing takes them out of its reach.
		const grid = this.pageEl?.querySelector<HTMLElement>(".bl-grid");
		if (grid) grid.toggleAttribute("inert", mode !== "off");
		if (mode !== "off" && document.activeElement instanceof HTMLElement) {
			document.activeElement.blur();
		}
	}

	// -- sections ----------------------------------------------------------

	private renderTasks(): void {
		const host = this.hosts.tasks;
		if (!host) return;
		host.empty();
		host.addClass("bl-tasks");

		this.model.tasks.forEach((task, index) => {
			const row = host.createDiv({ cls: "bl-row bl-task" });

			const star = row.createEl("button", { cls: "bl-star" });
			star.setText("✳");
			star.toggleClass("is-on", task.star);
			star.setAttr("aria-label", "Flag as priority");
			star.onclick = () => {
				task.star = !task.star;
				star.toggleClass("is-on", task.star);
				this.touch();
			};

			const check = this.checkbox(row, task.done, (done) => {
				task.done = done;
				row.toggleClass("is-done", done);
				this.touch();
			});
			check.setAttr("aria-label", "Toggle task");

			const input = row.createEl("input", {
				cls: "bl-input",
				attr: { type: "text", placeholder: "New task", value: task.text },
			});
			input.oninput = () => {
				task.text = input.value;
				this.touch();
			};
			input.onkeydown = (e) =>
				this.listKeys(e, input, index, {
					insert: (at) =>
						this.model.tasks.splice(at, 0, {
							id: uid("t"),
							text: "",
							done: false,
							star: false,
						}),
					remove: (at) => this.model.tasks.splice(at, 1),
					isEmpty: () => task.text.length === 0,
					rerender: () => this.renderTasks(),
					host,
				});

			this.deleteButton(row, () => {
				this.model.tasks.splice(index, 1);
				this.renderTasks();
				this.touch();
			});

			row.toggleClass("is-done", task.done);
		});

		this.addButton(host, "Add task", () => {
			this.model.tasks.push({ id: uid("t"), text: "", done: false, star: false });
			this.renderTasks();
			this.focusLast(host);
			this.touch();
		});
	}

	/**
	 * Weekday indices in the order the page shows them. The model always keys
	 * days Monday-first, so only the display rotates when the week starts Sunday.
	 */
	private get dayOrder(): number[] {
		const order = [0, 1, 2, 3, 4, 5, 6];
		return this.plugin.settings.weekStartsOn === 0
			? [6, 0, 1, 2, 3, 4, 5]
			: order;
	}

	private renderMeetings(): void {
		const host = this.hosts.meetings;
		if (!host) return;
		host.empty();
		host.addClass("bl-meetings");

		this.dayOrder.forEach((day, column) => {
			const items = this.model.meetings[day] ?? (this.model.meetings[day] = []);
			const block = host.createDiv({ cls: "bl-day" });
			block.dataset.day = String(day);
			if (items.length === 0) block.addClass("is-empty");

			const head = block.createDiv({ cls: "bl-day-head" });
			head.createSpan({ cls: "bl-day-name", text: DAY_NAMES[day] });
			head.createSpan({ cls: "bl-day-date", text: this.dateLabel(column) });

			const add = head.createEl("button", { cls: "bl-day-add" });
			bulletIcon(add, "plus");
			add.setAttr("aria-label", `Add a meeting on ${DAY_NAMES[day]}`);
			add.onclick = () => {
				items.push({ id: uid("m"), time: "", text: "" });
				this.renderMeetings();
				// Focus the row just added, not whichever day happens to sort last.
				this.focusLast(
					this.hosts.meetings?.querySelector<HTMLElement>(
						`.bl-day[data-day="${day}"]`
					) ?? undefined,
					".bl-time-input"
				);
				this.touch();
			};

			const list = block.createDiv({ cls: "bl-day-list" });

			items.forEach((item, index) => {
				const row = list.createDiv({ cls: "bl-row bl-meeting" });

				const time = row.createEl("input", {
					cls: "bl-input bl-time-input",
					attr: { type: "text", placeholder: "00:00", value: item.time },
				});
				time.oninput = () => {
					item.time = time.value;
					this.touch();
				};

				row.createSpan({ cls: "bl-dash", text: "—" });

				const text = row.createEl("input", {
					cls: "bl-input",
					attr: { type: "text", placeholder: "Meeting", value: item.text },
				});
				text.oninput = () => {
					item.text = text.value;
					this.touch();
				};
				text.onkeydown = (e) =>
					this.listKeys(e, text, index, {
						insert: (at) =>
							items.splice(at, 0, { id: uid("m"), time: "", text: "" }),
						remove: (at) => items.splice(at, 1),
						isEmpty: () => item.text.length === 0 && item.time.length === 0,
						rerender: () => this.renderMeetings(),
						host: list,
					});

				this.deleteButton(row, () => {
					items.splice(index, 1);
					this.renderMeetings();
					this.touch();
				});
			});

		});
	}

	private renderEvents(): void {
		const host = this.hosts.events;
		if (!host) return;
		host.empty();
		host.addClass("bl-events");

		this.model.events.forEach((ev, index) => {
			const row = host.createDiv({ cls: "bl-row bl-event" });

			const check = this.checkbox(row, ev.done, (done) => {
				ev.done = done;
				row.toggleClass("is-done", done);
				this.touch();
			});
			check.setAttr("aria-label", "Toggle event");

			const day = row.createEl("input", {
				cls: "bl-input bl-event-day",
				attr: { type: "text", placeholder: "Day", value: ev.day },
			});
			day.oninput = () => {
				ev.day = day.value;
				this.touch();
			};

			row.createSpan({ cls: "bl-dash", text: "—" });

			const text = row.createEl("input", {
				cls: "bl-input",
				attr: { type: "text", placeholder: "What's on", value: ev.text },
			});
			text.oninput = () => {
				ev.text = text.value;
				this.touch();
			};
			text.onkeydown = (e) =>
				this.listKeys(e, text, index, {
					insert: (at) =>
						this.model.events.splice(at, 0, {
							id: uid("e"),
							day: "",
							text: "",
							done: false,
						}),
					remove: (at) => this.model.events.splice(at, 1),
					isEmpty: () => ev.text.length === 0 && ev.day.length === 0,
					rerender: () => this.renderEvents(),
					host,
				});

			this.deleteButton(row, () => {
				this.model.events.splice(index, 1);
				this.renderEvents();
				this.touch();
			});

			row.toggleClass("is-done", ev.done);
		});

		this.addButton(host, "Add event", () => {
			this.model.events.push({ id: uid("e"), day: "", text: "", done: false });
			this.renderEvents();
			this.focusLast(host, ".bl-event-day");
			this.touch();
		});
	}

	private renderTrackers(): void {
		const host = this.hosts.habits;
		if (!host) return;
		host.empty();
		host.addClass("bl-trackers");

		const table = host.createDiv({ cls: "bl-habit-table" });

		table.createDiv({ cls: "bl-habit-corner" });
		for (const day of this.dayOrder) {
			const cell = table.createDiv({
				cls: "bl-habit-dayhead",
				text: DAY_INITIALS[day],
			});
			if (day >= 5) cell.addClass("is-weekend");
		}

		this.model.habits.forEach((habit, rowIndex) => {
			const name = table.createEl("input", {
				cls: "bl-input bl-habit-name",
				attr: { type: "text", placeholder: "Habit", value: habit.name },
			});
			name.oninput = () => {
				habit.name = name.value;
				this.touch();
			};
			name.onkeydown = (e) => {
				if (e.key === "Backspace" && habit.name.length === 0 && habit.cells.every((c) => !c)) {
					e.preventDefault();
					this.model.habits.splice(rowIndex, 1);
					this.renderTrackers();
					this.touch();
				}
			};

			for (const day of this.dayOrder) {
				const cell = table.createEl("input", {
					cls: "bl-input bl-habit-cell",
					attr: { type: "text", value: habit.cells[day] ?? "" },
				});
				if (day >= 5) cell.addClass("is-weekend");
				cell.oninput = () => {
					habit.cells[day] = cell.value;
					this.touch();
				};
				// A bare tap fills in a tick — the common case by a mile.
				cell.ondblclick = () => {
					habit.cells[day] = habit.cells[day] ? "" : "✓";
					cell.value = habit.cells[day];
					this.touch();
				};
			}
		});

		const addRow = host.createEl("button", { cls: "bl-add-inline" });
		bulletIcon(addRow.createSpan(), "plus");
		addRow.createSpan({ text: "Add habit" });
		addRow.onclick = () => {
			this.model.habits.push({ name: "", cells: ["", "", "", "", "", "", ""] });
			this.renderTrackers();
			this.focusLast(this.hosts.habits, ".bl-habit-name");
			this.touch();
		};

		this.renderTimeChart(host);
	}

	private renderTimeChart(host: HTMLElement): void {
		const wrap = host.createDiv({ cls: "bl-time" });

		const label = wrap.createEl("input", {
			cls: "bl-input bl-time-label",
			attr: { type: "text", value: this.model.timeLabel, placeholder: "Time blocks" },
		});
		label.oninput = () => {
			this.model.timeLabel = label.value;
			this.touch();
		};

		const chart = wrap.createDiv({ cls: "bl-time-chart" });
		const maxBlocks = Math.max(
			4,
			...Array.from({ length: 7 }, (_, day) =>
				this.model.time.reduce((sum, row) => sum + (row.blocks[day] ?? 0), 0)
			)
		);

		for (const day of this.dayOrder) {
			const col = chart.createDiv({ cls: "bl-time-col" });
			if (day >= 5) col.addClass("is-weekend");

			const stack = col.createDiv({ cls: "bl-time-stack" });
			stack.style.setProperty("--bl-max", String(maxBlocks));

			this.model.time.forEach((row, projectIndex) => {
				for (let n = 0; n < (row.blocks[day] ?? 0); n++) {
					const block = stack.createDiv({ cls: "bl-time-block" });
					block.style.setProperty("--bl-block", colorFor(projectIndex));
					block.setAttr("aria-label", `${row.project} — tap to remove`);
					block.onclick = () => {
						row.blocks[day] = Math.max(0, (row.blocks[day] ?? 0) - 1);
						this.renderTrackers();
						this.touch();
					};
				}
			});

			const add = col.createEl("button", { cls: "bl-time-add" });
			bulletIcon(add, "plus");
			add.setAttr("aria-label", `Log a block on ${DAY_NAMES[day]}`);
			add.onclick = (e) => this.pickProject(e, day);

			col.createDiv({ cls: "bl-time-day", text: DAY_INITIALS[day] });
		}

		const legend = wrap.createDiv({ cls: "bl-legend" });
		this.model.time.forEach((row, index) => {
			const item = legend.createDiv({ cls: "bl-legend-item" });
			const dot = item.createDiv({ cls: "bl-legend-dot" });
			dot.style.setProperty("--bl-block", colorFor(index));

			const code = item.createEl("input", {
				cls: "bl-input bl-legend-code",
				attr: { type: "text", value: row.project, placeholder: "Code" },
			});
			code.oninput = () => {
				row.project = code.value;
				this.touch();
			};

			const total = row.blocks.reduce((a, b) => a + (b ?? 0), 0);
			item.createSpan({ cls: "bl-legend-total", text: String(total) });
		});

		const addProject = legend.createEl("button", { cls: "bl-add-inline" });
		bulletIcon(addProject.createSpan(), "plus");
		addProject.createSpan({ text: "Project" });
		addProject.onclick = () => {
			this.model.time.push({ project: "", blocks: [0, 0, 0, 0, 0, 0, 0] });
			this.renderTrackers();
			this.focusLast(this.hosts.habits, ".bl-legend-code");
			this.touch();
		};
	}

	private pickProject(e: MouseEvent, day: number): void {
		const rows = this.model.time.filter((r) => r.project.trim().length > 0);
		if (rows.length === 0) {
			new Notice("Add a project code first");
			return;
		}
		if (rows.length === 1) {
			this.addBlock(rows[0], day);
			return;
		}
		const menu = new Menu();
		for (const row of this.model.time) {
			if (!row.project.trim()) continue;
			menu.addItem((item) =>
				item.setTitle(row.project).onClick(() => this.addBlock(row, day))
			);
		}
		menu.showAtMouseEvent(e);
	}

	private addBlock(row: TimeRow, day: number): void {
		row.blocks[day] = (row.blocks[day] ?? 0) + 1;
		this.renderTrackers();
		this.touch();
	}

	private renderNotes(parent: HTMLElement): void {
		const strip = parent.createDiv({ cls: "bl-notes-strip" });
		this.hosts.notes = strip;

		const toggle = strip.createEl("button", { cls: "bl-notes-toggle" });
		const caret = toggle.createSpan({ cls: "bl-notes-caret" });
		bulletIcon(caret, "chevron-right");
		toggle.createSpan({ cls: "bl-notes-title", text: "Notes" });
		const preview = toggle.createSpan({ cls: "bl-notes-preview" });

		const area = strip.createEl("textarea", {
			cls: "bl-notes",
			attr: { placeholder: "Anything else…" },
		});
		area.value = this.model.notes;

		const firstLine = () => this.model.notes.split("\n")[0]?.trim() ?? "";
		const syncPreview = () => {
			preview.setText(this.notesOpen ? "" : firstLine());
		};

		const sync = () => {
			strip.toggleClass("is-open", this.notesOpen);
			syncPreview();
		};

		toggle.onclick = () => {
			this.notesOpen = !this.notesOpen;
			sync();
			if (this.notesOpen) area.focus();
		};

		area.oninput = () => {
			this.model.notes = area.value;
			this.touch();
		};

		sync();
	}

	// -- small builders ----------------------------------------------------

	private card(
		parent: HTMLElement,
		title: string,
		areaClass: string
	): { card: HTMLElement; body: HTMLElement } {
		const card = parent.createDiv({ cls: `bl-card ${areaClass}` });
		card.createDiv({ cls: "bl-label", text: title });
		const body = card.createDiv({ cls: "bl-card-body" });
		return { card, body };
	}

	private checkbox(
		parent: HTMLElement,
		checked: boolean,
		onToggle: (v: boolean) => void
	): HTMLElement {
		const box = parent.createEl("button", { cls: "bl-check" });
		box.setAttr("role", "checkbox");
		box.setAttr("aria-checked", String(checked));
		box.toggleClass("is-checked", checked);
		bulletIcon(box.createSpan({ cls: "bl-check-mark" }), "check");
		box.onclick = () => {
			checked = !checked;
			box.toggleClass("is-checked", checked);
			box.setAttr("aria-checked", String(checked));
			onToggle(checked);
		};
		return box;
	}

	private deleteButton(parent: HTMLElement, onClick: () => void): HTMLElement {
		const btn = parent.createEl("button", { cls: "bl-del" });
		bulletIcon(btn, "x");
		btn.setAttr("aria-label", "Delete");
		btn.onclick = onClick;
		return btn;
	}

	private addButton(parent: HTMLElement, label: string, onClick: () => void): void {
		const btn = parent.createEl("button", { cls: "bl-add-inline" });
		bulletIcon(btn.createSpan(), "plus");
		btn.createSpan({ text: label });
		btn.onclick = onClick;
	}

	private iconButton(
		parent: HTMLElement,
		icon: string,
		label: string,
		onClick: () => void
	): HTMLElement {
		const btn = parent.createEl("button", { cls: "bl-icon-btn" });
		bulletIcon(btn, icon);
		btn.setAttr("aria-label", label);
		btn.onclick = onClick;
		return btn;
	}

	/** Enter splits a new row below; backspace on an empty row removes it. */
	private listKeys(
		e: KeyboardEvent,
		input: HTMLInputElement,
		index: number,
		ops: {
			insert: (at: number) => void;
			remove: (at: number) => void;
			isEmpty: () => boolean;
			rerender: () => void;
			host: HTMLElement;
		}
	): void {
		if (e.key === "Enter") {
			e.preventDefault();
			ops.insert(index + 1);
			ops.rerender();
			this.focusRow(ops.host, index + 1);
			this.touch();
			return;
		}
		if (e.key === "Backspace" && input.value.length === 0 && ops.isEmpty()) {
			e.preventDefault();
			ops.remove(index);
			ops.rerender();
			this.focusRow(ops.host, Math.max(0, index - 1), true);
			this.touch();
			return;
		}
		if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			const delta = e.key === "ArrowDown" ? 1 : -1;
			const moved = this.focusRow(ops.host, index + delta);
			if (moved) e.preventDefault();
		}
	}

	private focusRow(host: HTMLElement, index: number, atEnd = false): boolean {
		const rows = host.querySelectorAll<HTMLElement>(".bl-row");
		const row = rows[index];
		if (!row) return false;
		const inputs = row.querySelectorAll<HTMLInputElement>("input.bl-input");
		const target = inputs[inputs.length - 1];
		if (!target) return false;
		target.focus();
		if (atEnd) target.setSelectionRange(target.value.length, target.value.length);
		return true;
	}

	private focusLast(host: HTMLElement | undefined, selector = "input.bl-input"): void {
		if (!host) return;
		const all = host.querySelectorAll<HTMLInputElement>(selector);
		all[all.length - 1]?.focus();
	}

	/** `column` is the position on the page, not the weekday index. */
	private dateLabel(column: number): string {
		const start = parseISODate(this.model.start);
		if (!start) return "";
		const d = addDays(start, column);
		return `${String(d.getDate()).padStart(2, "0")}/${String(
			d.getMonth() + 1
		).padStart(2, "0")}`;
	}

	private stepWeek(delta: number): void {
		const start = parseISODate(this.model.start);
		if (!start) {
			new Notice("This page has no week set in its frontmatter");
			return;
		}
		void this.plugin.openWeekFor(addDays(start, delta * 7));
	}
}

function colorFor(index: number): string {
	return PROJECT_COLORS[index % PROJECT_COLORS.length];
}

export type { Task, Meeting, EventItem, HabitRow, WeekData };
