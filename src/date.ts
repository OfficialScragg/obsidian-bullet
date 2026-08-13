/**
 * Date helpers. Self-contained so the plugin does not depend on moment,
 * which Obsidian has soft-deprecated.
 */

export function startOfDay(d: Date): Date {
	const out = new Date(d.getTime());
	out.setHours(0, 0, 0, 0);
	return out;
}

export function addDays(d: Date, n: number): Date {
	const out = new Date(d.getTime());
	out.setDate(out.getDate() + n);
	return out;
}

/**
 * Start of the week containing `d`.
 * `weekStartsOn` is 1 for Monday, 0 for Sunday.
 */
export function startOfWeek(d: Date, weekStartsOn: 0 | 1 = 1): Date {
	const day = d.getDay();
	const diff = (day - weekStartsOn + 7) % 7;
	return startOfDay(addDays(d, -diff));
}

/** ISO-8601 week number (weeks start Monday, week 1 contains the first Thursday). */
export function isoWeek(d: Date): { year: number; week: number } {
	const target = startOfDay(d);
	// Thursday of the current ISO week decides the year.
	const dayNum = (target.getDay() + 6) % 7;
	target.setDate(target.getDate() - dayNum + 3);
	const isoYear = target.getFullYear();
	const firstThursday = new Date(isoYear, 0, 4);
	const firstDayNum = (firstThursday.getDay() + 6) % 7;
	firstThursday.setDate(firstThursday.getDate() - firstDayNum + 3);
	const week =
		1 + Math.round((target.getTime() - firstThursday.getTime()) / (7 * 86400000));
	return { year: isoYear, week };
}

function pad(n: number, len = 2): string {
	return String(n).padStart(len, "0");
}

export function formatISODate(d: Date): string {
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function parseISODate(s: string): Date | null {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
	if (!m) return null;
	const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
	return isNaN(d.getTime()) ? null : d;
}

const MONTHS_SHORT = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
];

/**
 * Token formatter supporting the subset people actually use in a filename:
 * YYYY YY MMMM MMM MM M DD D WW W ddd
 */
export function formatDate(d: Date, fmt: string): string {
	const { year, week } = isoWeek(d);
	const map: Record<string, string> = {
		// The ISO week-year, not the calendar year: pairing a calendar year with
		// WW collides at the turn of the year (1 Jan 2026 is week 53 of 2025).
		YYYY: String(year),
		GGGG: String(year),
		YY: pad(d.getFullYear() % 100),
		MMM: MONTHS_SHORT[d.getMonth()],
		MM: pad(d.getMonth() + 1),
		M: String(d.getMonth() + 1),
		DD: pad(d.getDate()),
		D: String(d.getDate()),
		WW: pad(week),
		W: String(week),
	};
	// Longest tokens first so MM does not eat MMM.
	const tokens = Object.keys(map).sort((a, b) => b.length - a.length);
	const re = new RegExp(`\\[([^\\]]*)\\]|${tokens.join("|")}`, "g");
	return fmt.replace(re, (match, literal) =>
		literal !== undefined ? literal : map[match]
	);
}

/** The "20/07 → 26/07" heading from the paper page. */
export function weekTitle(start: Date, end: Date): string {
	return `${pad(start.getDate())}/${pad(start.getMonth() + 1)} → ${pad(
		end.getDate()
	)}/${pad(end.getMonth() + 1)}`;
}

export function weekKey(start: Date): string {
	const { year, week } = isoWeek(start);
	return `${year}-W${pad(week)}`;
}
