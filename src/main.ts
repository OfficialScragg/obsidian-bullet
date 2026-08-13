import {
	MarkdownView,
	Notice,
	Plugin,
	TFile,
	TFolder,
	WorkspaceLeaf,
	normalizePath,
} from "obsidian";
import {
	BulletSettingTab,
	BulletSettings,
	DEFAULT_SETTINGS,
	parseRecurringMeetings,
} from "./settings";
import {
	FRONTMATTER_KEY,
	FRONTMATTER_VALUE,
	VIEW_TYPE_BULLET,
	WeekData,
	emptyWeek,
	uid,
} from "./types";
import { parseNote, serializeNote } from "./serialize";
import { BulletView } from "./view";
import { InkDiagnosticsModal } from "./diagnostics";
import { PenTestModal } from "./pentest";
import {
	addDays,
	formatDate,
	formatISODate,
	startOfWeek,
	weekKey,
	weekTitle,
} from "./date";

export default class BulletPlugin extends Plugin {
	settings: BulletSettings = { ...DEFAULT_SETTINGS };

	/** Files the user has deliberately opened as raw markdown this session. */
	private markdownOverride = new Set<string>();

	/** Leaves mid-swap, so a swap can't re-enter itself via layout-change. */
	private switching = new WeakSet<WorkspaceLeaf>();
	private syncQueued = false;
	private layoutReady = false;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.registerView(
			VIEW_TYPE_BULLET,
			(leaf: WorkspaceLeaf) => new BulletView(leaf, this)
		);

		this.addSettingTab(new BulletSettingTab(this.app, this));

		this.addRibbonIcon("pencil", "Bullet: this week", () => {
			void this.openWeekFor(new Date());
		});

		this.addCommand({
			id: "open-this-week",
			name: "Open this week",
			callback: () => void this.openWeekFor(new Date()),
		});

		this.addCommand({
			id: "open-next-week",
			name: "Open next week",
			callback: () => void this.openWeekFor(addDays(new Date(), 7)),
		});

		this.addCommand({
			id: "open-previous-week",
			name: "Open previous week",
			callback: () => void this.openWeekFor(addDays(new Date(), -7)),
		});

		this.addCommand({
			id: "open-as-markdown",
			name: "Open current page as markdown",
			checkCallback: (checking) => {
				const leaf = this.app.workspace.getMostRecentLeaf();
				const isBullet = leaf?.view.getViewType() === VIEW_TYPE_BULLET;
				if (checking) return !!isBullet;
				if (leaf) this.openAsMarkdown(leaf);
				return true;
			},
		});

		this.addCommand({
			id: "open-as-bullet",
			name: "Open current note as a Bullet page",
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				const file = view?.file;
				if (checking) return !!file && this.isBulletFile(file);
				if (view?.file && view.leaf) {
					this.markdownOverride.delete(view.file.path);
					const state = view.leaf.getViewState();
					state.type = VIEW_TYPE_BULLET;
					void view.leaf.setViewState(state);
				}
				return true;
			},
		});

		this.addCommand({
			id: "ink-diagnostics",
			name: "Diagnose ink performance",
			checkCallback: (checking) => {
				const leaf = this.app.workspace.getMostRecentLeaf();
				const view = leaf?.view;
				const isBullet = view instanceof BulletView;
				if (checking) return isBullet;
				if (view instanceof BulletView) this.openDiagnostics(view);
				return true;
			},
		});

		this.addCommand({
			id: "pen-test",
			name: "Pen test (bare canvas)",
			callback: () => new PenTestModal(this.app).open(),
		});

		this.registerEvent(
			this.app.workspace.on("layout-change", () => this.queueSync())
		);
		this.registerEvent(
			this.app.workspace.on("file-open", () => this.queueSync())
		);

		this.app.workspace.onLayoutReady(async () => {
			this.layoutReady = true;
			this.queueSync();
			if (this.settings.autoCreate) {
				await this.ensureWeekNote(new Date());
			}
			if (this.settings.openOnStartup) {
				await this.openWeekFor(new Date());
			}
			// Catches the week rolling over while Obsidian is left open.
			this.registerInterval(
				window.setInterval(() => {
					if (this.settings.autoCreate) void this.ensureWeekNote(new Date());
				}, 60 * 60 * 1000)
			);
		});
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	openPenTest(): void {
		new PenTestModal(this.app).open();
	}

	openDiagnostics(view: BulletView): void {
		new InkDiagnosticsModal(this.app, view, this).open();
	}

	refreshAllViews(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_BULLET)) {
			const view = leaf.view;
			if (view instanceof BulletView) view.refreshTheme();
		}
	}

	/**
	 * layout-change fires constantly, including while Obsidian is restoring the
	 * workspace at startup. Swapping views synchronously from inside it meant
	 * this plugin was fighting that restore — coalesce to one pass per tick and
	 * never run before the layout is ready.
	 */
	private queueSync(): void {
		if (!this.layoutReady || this.syncQueued) return;
		this.syncQueued = true;
		window.setTimeout(() => {
			this.syncQueued = false;
			this.syncLeaves();
		}, 0);
	}

	// -- view swapping -----------------------------------------------------

	private isBulletFile(file: TFile): boolean {
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
		return fm?.[FRONTMATTER_KEY] === FRONTMATTER_VALUE;
	}

	/** Re-open any markdown leaf showing a Bullet note as the Bullet page. */
	private syncLeaves(): void {
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			if (this.switching.has(leaf)) continue;

			const view = leaf.view;
			if (!(view instanceof MarkdownView)) continue;
			const file = view.file;
			if (!file) continue;
			if (this.markdownOverride.has(file.path)) continue;
			if (!this.isBulletFile(file)) continue;

			const state = leaf.getViewState();
			if (state.type === VIEW_TYPE_BULLET) continue;
			state.type = VIEW_TYPE_BULLET;

			this.switching.add(leaf);
			leaf
				.setViewState(state)
				.catch((err) => console.error("Bullet: could not open the page", err))
				.finally(() => this.switching.delete(leaf));
		}
	}

	openAsMarkdown(leaf: WorkspaceLeaf): void {
		const file = (leaf.view as { file?: TFile | null }).file;
		if (file) this.markdownOverride.add(file.path);
		const state = leaf.getViewState();
		state.type = "markdown";
		void leaf.setViewState(state);
	}

	// -- week files --------------------------------------------------------

	weekStartFor(date: Date): Date {
		return startOfWeek(date, this.settings.weekStartsOn);
	}

	pathForWeek(date: Date): string {
		const start = this.weekStartFor(date);
		const name = formatDate(start, this.settings.filenameFormat);
		const folder = this.settings.folder.replace(/^\/+|\/+$/g, "");
		return normalizePath(folder ? `${folder}/${name}.md` : `${name}.md`);
	}

	private async ensureFolder(path: string): Promise<void> {
		const dir = path.split("/").slice(0, -1).join("/");
		if (!dir) return;
		const existing = this.app.vault.getAbstractFileByPath(dir);
		if (existing instanceof TFolder) return;
		if (existing) throw new Error(`Bullet: "${dir}" exists and is not a folder`);
		await this.app.vault.createFolder(dir);
	}

	/** Create this week's page if it is missing. Returns the file either way. */
	async ensureWeekNote(date: Date): Promise<TFile | null> {
		const path = this.pathForWeek(date);
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) return existing;

		try {
			await this.ensureFolder(path);
			const content = serializeNote(
				await this.buildWeek(date),
				[],
				this.settings.compactInk
			);
			return await this.app.vault.create(path, content);
		} catch (err) {
			// Another window may have won the race; take whatever is there now.
			const raced = this.app.vault.getAbstractFileByPath(path);
			if (raced instanceof TFile) return raced;
			console.error("Bullet: could not create the weekly page", err);
			new Notice(`Bullet: could not create ${path}`);
			return null;
		}
	}

	async openWeekFor(date: Date): Promise<void> {
		const file = await this.ensureWeekNote(date);
		if (!file) return;
		this.markdownOverride.delete(file.path);

		const leaf = this.app.workspace.getLeaf(false);
		await leaf.openFile(file);
		const state = leaf.getViewState();
		if (state.type !== VIEW_TYPE_BULLET) {
			state.type = VIEW_TYPE_BULLET;
			await leaf.setViewState(state);
		}
	}

	/** Assemble a fresh week from settings, plus anything carried over. */
	private async buildWeek(date: Date): Promise<WeekData> {
		const start = this.weekStartFor(date);
		const end = addDays(start, 6);

		const data = emptyWeek();
		data.weekKey = weekKey(start);
		data.start = formatISODate(start);
		data.end = formatISODate(end);
		data.title = weekTitle(start, end);

		data.habits = this.settings.habits.map((name) => ({
			name,
			cells: ["", "", "", "", "", "", ""],
		}));
		data.timeLabel = this.settings.timeLabel;
		data.time = this.settings.projects.map((project) => ({
			project,
			blocks: [0, 0, 0, 0, 0, 0, 0],
		}));

		for (const rec of parseRecurringMeetings(this.settings.recurringMeetings)) {
			data.meetings[rec.day].push({ id: uid("m"), time: rec.time, text: rec.text });
		}
		for (const bucket of data.meetings) {
			bucket.sort((a, b) => a.time.localeCompare(b.time));
		}

		if (this.settings.carryOverTasks) {
			const previous = this.app.vault.getAbstractFileByPath(
				this.pathForWeek(addDays(start, -7))
			);
			if (previous instanceof TFile) {
				try {
					const raw = await this.app.vault.cachedRead(previous);
					const prior = parseNote(raw);
					data.tasks = prior.tasks
						.filter((t) => !t.done && t.text.trim().length > 0)
						.map((t) => ({ ...t, id: uid("t") }));
				} catch (err) {
					console.error("Bullet: could not read the previous week", err);
				}
			}
		}

		return data;
	}
}
