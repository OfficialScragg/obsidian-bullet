import { App, PluginSettingTab, Setting, TextAreaComponent } from "obsidian";
import type BulletPlugin from "./main";

export interface BulletSettings {
	folder: string;
	filenameFormat: string;
	weekStartsOn: 0 | 1;
	autoCreate: boolean;
	openOnStartup: boolean;
	carryOverTasks: boolean;
	habits: string[];
	projects: string[];
	timeLabel: string;
	/** One per line: `Mon | 10:30 | WE Stand up` */
	recurringMeetings: string;
	penColors: string[];
	penWidth: number;
	fingerDraw: boolean;
	useThemeColors: boolean;
	compactInk: boolean;
}

export const DEFAULT_SETTINGS: BulletSettings = {
	folder: "Bullet",
	filenameFormat: "YYYY-[W]WW",
	weekStartsOn: 1,
	autoCreate: true,
	openOnStartup: false,
	carryOverTasks: true,
	habits: ["Mornings", "Exercise"],
	projects: ["WE", "CL", "OS", "FR"],
	timeLabel: "2 Hours",
	recurringMeetings: "",
	penColors: ["#e8eaee", "#c9a227", "#6fa8dc", "#e06c75"],
	penWidth: 2.4,
	fingerDraw: false,
	useThemeColors: false,
	compactInk: true,
};

function parseList(raw: string): string[] {
	return raw
		.split(/[\n,]/)
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

export interface RecurringMeeting {
	day: number;
	time: string;
	text: string;
}

const DAY_LOOKUP: Record<string, number> = {
	mon: 0,
	monday: 0,
	tue: 1,
	tues: 1,
	tuesday: 1,
	wed: 2,
	weds: 2,
	wednesday: 2,
	thu: 3,
	thur: 3,
	thurs: 3,
	thursday: 3,
	fri: 4,
	friday: 4,
	sat: 5,
	saturday: 5,
	sun: 6,
	sunday: 6,
};

export function parseRecurringMeetings(raw: string): RecurringMeeting[] {
	const out: RecurringMeeting[] = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const parts = trimmed.split("|").map((p) => p.trim());
		if (parts.length < 3) continue;
		const day = DAY_LOOKUP[parts[0].toLowerCase()];
		if (day === undefined) continue;
		out.push({ day, time: parts[1], text: parts.slice(2).join(" | ") });
	}
	return out;
}

export class BulletSettingTab extends PluginSettingTab {
	plugin: BulletPlugin;

	constructor(app: App, plugin: BulletPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName("Notes").setHeading();

		new Setting(containerEl)
			.setName("Folder")
			.setDesc("Where weekly pages are created.")
			.addText((t) =>
				t
					.setPlaceholder("Bullet")
					.setValue(this.plugin.settings.folder)
					.onChange(async (v) => {
						this.plugin.settings.folder = v.replace(/^\/+|\/+$/g, "");
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Filename format")
			.setDesc(
				"Tokens: YYYY, YY, MMM, MM, DD, WW (ISO week). Wrap literals in [brackets]."
			)
			.addText((t) =>
				t
					.setPlaceholder("YYYY-[W]WW")
					.setValue(this.plugin.settings.filenameFormat)
					.onChange(async (v) => {
						this.plugin.settings.filenameFormat = v || "YYYY-[W]WW";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Week starts on")
			.addDropdown((d) =>
				d
					.addOption("1", "Monday")
					.addOption("0", "Sunday")
					.setValue(String(this.plugin.settings.weekStartsOn))
					.onChange(async (v) => {
						this.plugin.settings.weekStartsOn = v === "0" ? 0 : 1;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Create this week's page automatically")
			.setDesc("Checked on startup and when the date rolls over.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.autoCreate).onChange(async (v) => {
					this.plugin.settings.autoCreate = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Open this week's page on startup")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.openOnStartup).onChange(async (v) => {
					this.plugin.settings.openOnStartup = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Carry over unfinished tasks")
			.setDesc(
				"When a new week is created, copy the previous week's unticked tasks across."
			)
			.addToggle((t) =>
				t.setValue(this.plugin.settings.carryOverTasks).onChange(async (v) => {
					this.plugin.settings.carryOverTasks = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl).setName("Page layout").setHeading();

		new Setting(containerEl)
			.setName("Habit rows")
			.setDesc("One per line. These become the tracker rows at the foot of the page.")
			.addTextArea((t) => {
				sizeTextArea(t, 4);
				t.setValue(this.plugin.settings.habits.join("\n")).onChange(async (v) => {
					this.plugin.settings.habits = parseList(v);
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Time block label")
			.setDesc("The heading over the stacked time chart.")
			.addText((t) =>
				t
					.setPlaceholder("2 Hours")
					.setValue(this.plugin.settings.timeLabel)
					.onChange(async (v) => {
						this.plugin.settings.timeLabel = v || "2 Hours";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Project codes")
			.setDesc("One per line. Each is a band in the time chart.")
			.addTextArea((t) => {
				sizeTextArea(t, 4);
				t.setValue(this.plugin.settings.projects.join("\n")).onChange(async (v) => {
					this.plugin.settings.projects = parseList(v);
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Recurring meetings")
			.setDesc(
				"Pre-filled into every new page. One per line: Day | Time | Description — e.g. Mon | 10:30 | WE Stand up"
			)
			.addTextArea((t) => {
				sizeTextArea(t, 6);
				t.setPlaceholder("Mon | 10:30 | WE Stand up")
					.setValue(this.plugin.settings.recurringMeetings)
					.onChange(async (v) => {
						this.plugin.settings.recurringMeetings = v;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl).setName("Ink").setHeading();

		new Setting(containerEl)
			.setName("Pen colours")
			.setDesc("One hex colour per line. Shown in the drawing toolbar.")
			.addTextArea((t) => {
				sizeTextArea(t, 4);
				t.setValue(this.plugin.settings.penColors.join("\n")).onChange(async (v) => {
					const list = parseList(v).filter((c) => /^#[0-9a-fA-F]{3,8}$/.test(c));
					this.plugin.settings.penColors = list.length
						? list
						: DEFAULT_SETTINGS.penColors;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Pen width")
			.setDesc("Base stroke width. Apple Pencil pressure varies around this.")
			.addSlider((s) =>
				s
					.setLimits(1, 8, 0.2)
					.setDynamicTooltip()
					.setValue(this.plugin.settings.penWidth)
					.onChange(async (v) => {
						this.plugin.settings.penWidth = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Draw with finger")
			.setDesc(
				"Off means only an Apple Pencil draws, and a finger scrolls the page — palm and thumb rejection."
			)
			.addToggle((t) =>
				t.setValue(this.plugin.settings.fingerDraw).onChange(async (v) => {
					this.plugin.settings.fingerDraw = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Compact ink storage")
			.setDesc(
				"Stores strokes delta-encoded, roughly a fifth the size. Turn off to keep the ink block as plain readable JSON."
			)
			.addToggle((t) =>
				t.setValue(this.plugin.settings.compactInk).onChange(async (v) => {
					this.plugin.settings.compactInk = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl).setName("Appearance").setHeading();

		new Setting(containerEl)
			.setName("Follow Obsidian theme colours")
			.setDesc(
				"Off uses Bullet's own dark palette on every theme, so the page always looks the same."
			)
			.addToggle((t) =>
				t.setValue(this.plugin.settings.useThemeColors).onChange(async (v) => {
					this.plugin.settings.useThemeColors = v;
					await this.plugin.saveSettings();
					this.plugin.refreshAllViews();
				})
			);
	}
}

function sizeTextArea(t: TextAreaComponent, rows: number): void {
	t.inputEl.rows = rows;
	t.inputEl.style.width = "100%";
	t.inputEl.style.fontFamily = "var(--font-monospace)";
}
