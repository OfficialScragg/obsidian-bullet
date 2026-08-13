export const VIEW_TYPE_BULLET = "bullet-weekly-view";
export const FRONTMATTER_KEY = "bullet";
export const FRONTMATTER_VALUE = "weekly";

/** 0 = Monday … 6 = Sunday (the page always reads Mon→Sun like the paper journal). */
export type DayIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export const DAY_NAMES = [
	"Monday",
	"Tuesday",
	"Wednesday",
	"Thursday",
	"Friday",
	"Saturday",
	"Sunday",
];

export const DAY_INITIALS = ["M", "T", "W", "T", "F", "S", "S"];

export interface Task {
	id: string;
	text: string;
	done: boolean;
	star: boolean;
}

export interface Meeting {
	id: string;
	time: string;
	text: string;
}

export interface EventItem {
	id: string;
	day: string;
	text: string;
	done: boolean;
}

export interface HabitRow {
	name: string;
	/** Always length 7, Mon→Sun. Free text — a tick, a number, "10 pups". */
	cells: string[];
}

export interface TimeRow {
	project: string;
	/** Always length 7, Mon→Sun. Number of blocks logged that day. */
	blocks: number[];
}

export interface InkPoint {
	x: number;
	y: number;
	p: number;
}

export interface Stroke {
	color: string;
	width: number;
	/** true when drawn with the eraser in highlighter-style "erase to background" mode. */
	points: InkPoint[];
}

export interface WeekData {
	weekKey: string;
	start: string;
	end: string;
	title: string;
	tasks: Task[];
	/** 7 buckets, Mon→Sun. */
	meetings: Meeting[][];
	events: EventItem[];
	habits: HabitRow[];
	timeLabel: string;
	time: TimeRow[];
	notes: string;
	ink: Stroke[];
}

let idCounter = 0;
export function uid(prefix = "b"): string {
	idCounter += 1;
	return `${prefix}${Date.now().toString(36)}${idCounter.toString(36)}`;
}

export function emptyWeek(): WeekData {
	return {
		weekKey: "",
		start: "",
		end: "",
		title: "",
		tasks: [],
		meetings: [[], [], [], [], [], [], []],
		events: [],
		habits: [],
		timeLabel: "2 Hours",
		time: [],
		notes: "",
		ink: [],
	};
}
