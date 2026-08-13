import {
	DAY_INITIALS,
	DAY_NAMES,
	EventItem,
	FRONTMATTER_KEY,
	FRONTMATTER_VALUE,
	HabitRow,
	Meeting,
	Task,
	TimeRow,
	WeekData,
	emptyWeek,
	uid,
} from "./types";
import { decodeInk, encodeInk } from "./ink";

const STAR = "⭐";
const DASH = "—";
const INK_FENCE = "bullet-ink";

const SECTION = {
	tasks: "Tasks",
	meetings: "Meetings",
	events: "Events",
	trackers: "Trackers",
	time: "Time",
	notes: "Notes",
	ink: "Ink",
};

/** Frontmatter keys Bullet owns; anything else in the block is passed through. */
const OWNED_KEYS = new Set([FRONTMATTER_KEY, "week", "start", "end"]);

interface ParsedNote {
	frontmatter: Map<string, string>;
	extraFrontmatter: string[];
	body: string;
}

function splitFrontmatter(content: string): ParsedNote {
	const frontmatter = new Map<string, string>();
	const extraFrontmatter: string[] = [];

	if (!content.startsWith("---")) {
		return { frontmatter, extraFrontmatter, body: content };
	}
	const end = content.indexOf("\n---", 3);
	if (end === -1) {
		return { frontmatter, extraFrontmatter, body: content };
	}

	const block = content.slice(content.indexOf("\n") + 1, end);
	for (const line of block.split("\n")) {
		const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
		if (m && OWNED_KEYS.has(m[1])) {
			frontmatter.set(m[1], m[2].trim().replace(/^["']|["']$/g, ""));
		} else if (line.trim().length > 0) {
			extraFrontmatter.push(line);
		}
	}

	const afterEnd = content.indexOf("\n", end + 1);
	const body = afterEnd === -1 ? "" : content.slice(afterEnd + 1);
	return { frontmatter, extraFrontmatter, body };
}

/** Split the body into `## Section` buckets, keeping everything before the first one. */
function splitSections(body: string): Map<string, string[]> {
	const sections = new Map<string, string[]>();
	let current = "";
	let inFence = false;

	for (const line of body.split("\n")) {
		if (/^\s*```/.test(line)) inFence = !inFence;

		const heading = !inFence && /^##\s+(.+?)\s*$/.exec(line);
		if (heading) {
			current = heading[1].trim().toLowerCase();
			if (!sections.has(current)) sections.set(current, []);
			continue;
		}
		if (!sections.has(current)) sections.set(current, []);
		sections.get(current)!.push(line);
	}
	return sections;
}

function escapeCell(s: string): string {
	return s.replace(/\|/g, "\\|").trim();
}

function unescapeCell(s: string): string {
	return s.replace(/\\\|/g, "|").trim();
}

function parseTableRows(lines: string[]): string[][] {
	const rows: string[][] = [];
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("|")) continue;
		// Separator row: | --- | --- |
		if (/^\|[\s:|-]+\|?$/.test(trimmed) && trimmed.includes("-")) continue;
		const cells = trimmed
			.replace(/^\|/, "")
			.replace(/\|$/, "")
			.split(/(?<!\\)\|/)
			.map(unescapeCell);
		rows.push(cells);
	}
	return rows;
}

function padCells(cells: string[]): string[] {
	const out = cells.slice(0, 7);
	while (out.length < 7) out.push("");
	return out;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function parseTasks(lines: string[]): Task[] {
	const tasks: Task[] = [];
	for (const line of lines) {
		const m = /^\s*[-*]\s+\[([ xX])\]\s*(.*)$/.exec(line);
		if (!m) continue;
		let text = m[2].trim();
		let star = false;
		const starMatch = /^(⭐|\*|!)\s*/.exec(text);
		if (starMatch) {
			star = true;
			text = text.slice(starMatch[0].length);
		}
		tasks.push({
			id: uid("t"),
			text,
			done: m[1].toLowerCase() === "x",
			star,
		});
	}
	return tasks;
}

function parseMeetings(lines: string[]): Meeting[][] {
	const buckets: Meeting[][] = [[], [], [], [], [], [], []];
	let day = -1;
	for (const line of lines) {
		const heading = /^###\s+(.+?)\s*$/.exec(line);
		if (heading) {
			day = DAY_NAMES.findIndex(
				(n) => n.toLowerCase() === heading[1].trim().toLowerCase()
			);
			continue;
		}
		if (day < 0) continue;
		const m = /^\s*[-*]\s+(.*)$/.exec(line);
		if (!m) continue;
		const rest = m[1].trim();
		if (!rest) continue;

		const withTime = /^(\d{1,2}[:.]\d{2})\s*[—–-]?\s*(.*)$/.exec(rest);
		if (withTime) {
			buckets[day].push({
				id: uid("m"),
				time: withTime[1].replace(".", ":"),
				text: withTime[2].trim(),
			});
		} else {
			buckets[day].push({ id: uid("m"), time: "", text: rest });
		}
	}
	return buckets;
}

function parseEvents(lines: string[]): EventItem[] {
	const events: EventItem[] = [];
	for (const line of lines) {
		const m = /^\s*[-*]\s+\[([ xX])\]\s*(.*)$/.exec(line);
		if (!m) continue;
		const rest = m[2].trim();
		const split = /^(.*?)\s+[—–]\s+(.*)$/.exec(rest);
		events.push({
			id: uid("e"),
			day: split ? split[1].trim() : "",
			text: split ? split[2].trim() : rest,
			done: m[1].toLowerCase() === "x",
		});
	}
	return events;
}

function parseHabits(lines: string[]): HabitRow[] {
	const rows = parseTableRows(lines);
	const habits: HabitRow[] = [];
	for (const row of rows) {
		const name = row[0]?.trim() ?? "";
		if (!name) continue;
		// Skip the header row.
		if (name.toLowerCase() === "habit" || name.toLowerCase() === "tracker") continue;
		habits.push({ name, cells: padCells(row.slice(1)) });
	}
	return habits;
}

function parseTime(lines: string[]): TimeRow[] {
	const rows = parseTableRows(lines);
	const time: TimeRow[] = [];
	for (const row of rows) {
		const project = row[0]?.trim() ?? "";
		if (!project) continue;
		if (project.toLowerCase() === "project") continue;
		const blocks = padCells(row.slice(1)).map((c) => {
			const n = parseInt(c, 10);
			return Number.isFinite(n) && n > 0 ? n : 0;
		});
		time.push({ project, blocks });
	}
	return time;
}

function parseInk(lines: string[]): string {
	const text = lines.join("\n");
	const fence = new RegExp("```" + INK_FENCE + "\\n([\\s\\S]*?)```", "m").exec(text);
	if (fence) return fence[1];
	return "";
}

export function parseNote(content: string): WeekData {
	const { frontmatter, body } = splitFrontmatter(content);
	const sections = splitSections(body);
	const data = emptyWeek();

	data.weekKey = frontmatter.get("week") ?? "";
	data.start = frontmatter.get("start") ?? "";
	data.end = frontmatter.get("end") ?? "";

	const preamble = sections.get("") ?? [];
	const title = preamble.find((l) => /^#\s+/.test(l));
	data.title = title ? title.replace(/^#\s+/, "").trim() : "";

	data.tasks = parseTasks(sections.get(SECTION.tasks.toLowerCase()) ?? []);
	data.meetings = parseMeetings(sections.get(SECTION.meetings.toLowerCase()) ?? []);
	data.events = parseEvents(sections.get(SECTION.events.toLowerCase()) ?? []);
	data.habits = parseHabits(sections.get(SECTION.trackers.toLowerCase()) ?? []);
	data.time = parseTime(sections.get(SECTION.time.toLowerCase()) ?? []);
	data.notes = (sections.get(SECTION.notes.toLowerCase()) ?? []).join("\n").trim();
	data.ink = decodeInk(parseInk(sections.get(SECTION.ink.toLowerCase()) ?? []));

	// The time chart label lives in the table header so the note stays self-describing.
	const timeLines = sections.get(SECTION.time.toLowerCase()) ?? [];
	const header = parseTableRows(timeLines)[0];
	if (header && header[0]?.toLowerCase() === "project") {
		const labelLine = timeLines.find((l) => /^\*\*/.test(l.trim()));
		if (labelLine) data.timeLabel = labelLine.replace(/\*\*/g, "").trim();
	}

	return data;
}

// ---------------------------------------------------------------------------
// Serialising
// ---------------------------------------------------------------------------

export function serializeNote(
	data: WeekData,
	extraFrontmatter: string[],
	compactInk: boolean
): string {
	const out: string[] = [];

	out.push("---");
	out.push(`${FRONTMATTER_KEY}: ${FRONTMATTER_VALUE}`);
	if (data.weekKey) out.push(`week: ${data.weekKey}`);
	if (data.start) out.push(`start: ${data.start}`);
	if (data.end) out.push(`end: ${data.end}`);
	for (const line of extraFrontmatter) out.push(line);
	out.push("---");
	out.push("");

	out.push(`# ${data.title}`);
	out.push("");

	out.push(`## ${SECTION.tasks}`);
	out.push("");
	for (const task of data.tasks) {
		const box = task.done ? "[x]" : "[ ]";
		const star = task.star ? `${STAR} ` : "";
		out.push(`- ${box} ${star}${task.text}`.trimEnd());
	}
	out.push("");

	out.push(`## ${SECTION.meetings}`);
	out.push("");
	for (let day = 0; day < 7; day++) {
		const items = data.meetings[day] ?? [];
		if (items.length === 0) continue;
		out.push(`### ${DAY_NAMES[day]}`);
		out.push("");
		for (const item of items) {
			out.push(
				item.time
					? `- ${item.time} ${DASH} ${item.text}`.trimEnd()
					: `- ${item.text}`.trimEnd()
			);
		}
		out.push("");
	}

	out.push(`## ${SECTION.events}`);
	out.push("");
	for (const ev of data.events) {
		const box = ev.done ? "[x]" : "[ ]";
		out.push(
			ev.day ? `- ${box} ${ev.day} ${DASH} ${ev.text}`.trimEnd() : `- ${box} ${ev.text}`.trimEnd()
		);
	}
	out.push("");

	out.push(`## ${SECTION.trackers}`);
	out.push("");
	out.push(`| Habit | ${DAY_INITIALS.join(" | ")} |`);
	out.push(`| --- | ${DAY_INITIALS.map(() => "---").join(" | ")} |`);
	for (const habit of data.habits) {
		out.push(
			`| ${escapeCell(habit.name)} | ${padCells(habit.cells)
				.map(escapeCell)
				.join(" | ")} |`
		);
	}
	out.push("");

	out.push(`## ${SECTION.time}`);
	out.push("");
	out.push(`**${data.timeLabel}**`);
	out.push("");
	out.push(`| Project | ${DAY_INITIALS.join(" | ")} |`);
	out.push(`| --- | ${DAY_INITIALS.map(() => "---").join(" | ")} |`);
	for (const row of data.time) {
		out.push(
			`| ${escapeCell(row.project)} | ${row.blocks
				.slice(0, 7)
				.map((n) => String(n ?? 0))
				.join(" | ")} |`
		);
	}
	out.push("");

	out.push(`## ${SECTION.notes}`);
	out.push("");
	if (data.notes.trim()) {
		out.push(data.notes.trim());
		out.push("");
	}

	const ink = encodeInk(data.ink, compactInk);
	out.push(`## ${SECTION.ink}`);
	out.push("");
	out.push("```" + INK_FENCE);
	if (ink) out.push(ink);
	out.push("```");
	out.push("");

	return out.join("\n");
}

/** Pull through any frontmatter keys other plugins have added. */
export function readExtraFrontmatter(content: string): string[] {
	return splitFrontmatter(content).extraFrontmatter;
}

export function isBulletNote(content: string): boolean {
	const { frontmatter } = splitFrontmatter(content);
	return frontmatter.get(FRONTMATTER_KEY) === FRONTMATTER_VALUE;
}
