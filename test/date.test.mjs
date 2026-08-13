import { startOfWeek, isoWeek, formatDate, weekTitle, weekKey, addDays, formatISODate } from "./date.mjs";

let ok = true;
const t = (label, got, want) => {
  const pass = String(got) === String(want);
  if (!pass) ok = false;
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}  got=${got} want=${want}`);
};

// The week in the photo: 20/07 -> 26/07 2026 (Mon 20 Jul 2026).
const d = new Date(2026, 6, 22); // Wed 22 Jul 2026
const s = startOfWeek(d, 1);
t("week start is Monday 20 Jul", formatISODate(s), "2026-07-20");
t("title matches the paper page", weekTitle(s, addDays(s, 6)), "20/07 → 26/07");
t("iso week number", isoWeek(s).week, 30);
t("week key", weekKey(s), "2026-W30");
t("filename", formatDate(s, "YYYY-[W]WW"), "2026-W30");

// Year boundaries.
t("1 Jan 2026 -> 2026-W01", formatDate(new Date(2026, 0, 1), "YYYY-[W]WW"), "2026-W01");
t("1 Jan 2027 -> 2026-W53", formatDate(new Date(2027, 0, 1), "YYYY-[W]WW"), "2026-W53");
t("4 Jan 2027 -> 2027-W01", formatDate(new Date(2027, 0, 4), "YYYY-[W]WW"), "2027-W01");
t("31 Dec 2026 -> 2026-W53", formatDate(new Date(2026, 11, 31), "YYYY-[W]WW"), "2026-W53");

// No two adjacent weeks share a filename across a 6-year sweep.
let cursor = startOfWeek(new Date(2024, 0, 1), 1);
const seen = new Map();
for (let i = 0; i < 320; i++) {
  const name = formatDate(cursor, "YYYY-[W]WW");
  if (seen.has(name)) { console.log(`FAIL  collision ${name}: ${seen.get(name)} vs ${formatISODate(cursor)}`); ok = false; }
  seen.set(name, formatISODate(cursor));
  cursor = addDays(cursor, 7);
}
console.log(`${ok ? "PASS" : "FAIL"}  320 consecutive weeks all map to unique filenames`);

t("other tokens", formatDate(s, "DD-MMM-YYYY"), "20-Jul-2026");
t("sunday start", formatISODate(startOfWeek(new Date(2026, 6, 22), 0)), "2026-07-19");
process.exit(ok ? 0 : 1);
