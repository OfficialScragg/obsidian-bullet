import { parseNote, serializeNote } from "./bundle.mjs";

const sample = `---
bullet: weekly
week: 2026-W33
start: 2026-08-10
end: 2026-08-16
tags: [journal]
---

# 10/08 → 16/08

## Tasks

- [x] ⭐ Electrum SUV testing
- [ ] Electrum ABSA report
- [x] CIB testing
- [ ] ⭐ Message Talbot

## Meetings

### Monday

- 10:00 — CL Stand up
- 10:30 — WE Stand up

### Friday

- 14:00 — CL Show & Tell

## Events

- [x] Tuesday — Portia
- [ ] Wednesday — Matt coffee

## Trackers

| Habit | M | T | W | T | F | S | S |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Mornings | S | O | O | O | O |  |  |
| Exercise | 10 pups |  |  |  |  |  |  |

## Time

**2 Hours**

| Project | M | T | W | T | F | S | S |
| --- | --- | --- | --- | --- | --- | --- | --- |
| WE | 1 | 2 | 1 | 1 | 2 | 0 | 0 |
| CL | 0 | 0 | 0 | 0 | 1 | 0 | 0 |

## Notes

Remember to chase the invoice.

## Ink

\`\`\`bullet-ink
#c9a227 2.4 120,340,50 8,2,62 9,-1,71
#6fa8dc 4 500,100,40 -12,20,55
\`\`\`
`;

const parsed = parseNote(sample);
const out = serializeNote(parsed, ["tags: [journal]"], true);
const reparsed = parseNote(out);

function check(label, a, b) {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) console.log("   first :", JSON.stringify(a), "\n   second:", JSON.stringify(b));
  return ok;
}

let ok = true;
ok &= check("tasks", parsed.tasks.map(t => [t.text, t.done, t.star]), reparsed.tasks.map(t => [t.text, t.done, t.star]));
ok &= check("meetings", parsed.meetings.map(d => d.map(m => [m.time, m.text])), reparsed.meetings.map(d => d.map(m => [m.time, m.text])));
ok &= check("events", parsed.events.map(e => [e.day, e.text, e.done]), reparsed.events.map(e => [e.day, e.text, e.done]));
ok &= check("habits", parsed.habits, reparsed.habits);
ok &= check("time", parsed.time, reparsed.time);
ok &= check("timeLabel", parsed.timeLabel, reparsed.timeLabel);
ok &= check("notes", parsed.notes, reparsed.notes);
ok &= check("frontmatter", [parsed.weekKey, parsed.start, parsed.end, parsed.title], [reparsed.weekKey, reparsed.start, reparsed.end, reparsed.title]);
ok &= check("ink stroke count", parsed.ink.length, reparsed.ink.length);
ok &= check("ink geometry", parsed.ink.map(s => [s.color, s.width, s.points.map(p => [p.x, p.y, Math.round(p.p * 100)])]),
                             reparsed.ink.map(s => [s.color, s.width, s.points.map(p => [p.x, p.y, Math.round(p.p * 100)])]));
ok &= check("stable second pass", out, serializeNote(reparsed, ["tags: [journal]"], true));
ok &= check("extra frontmatter kept", out.includes("tags: [journal]"), true);

console.log("\n--- serialized ---\n" + out);
process.exit(ok ? 0 : 1);
