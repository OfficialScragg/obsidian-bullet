import { Stroke, InkPoint } from "./types";

/**
 * Ink is stored in a resolution-independent space: x runs 0→1000 across the
 * width of the page and y uses the same scale, so a page drawn on an iPad
 * reopens correctly on a desktop at a different width.
 */
export const INK_SPACE = 1000;

const COORD_SCALE = 10; // one decimal place of precision

function round(n: number): number {
	return Math.round(n * COORD_SCALE);
}

/**
 * Compact form. One stroke per line:
 *   #rrggbb width x,y,pressure dx,dy,pressure dx,dy,pressure …
 * Coordinates are delta-encoded tenths; pressure is 0–100.
 */
export function encodeInk(strokes: Stroke[], compact: boolean): string {
	if (strokes.length === 0) return "";
	if (!compact) return JSON.stringify(strokes, null, 1);

	const lines: string[] = [];
	for (const stroke of strokes) {
		if (stroke.points.length === 0) continue;
		let px = 0;
		let py = 0;
		const parts: string[] = [];
		for (const pt of stroke.points) {
			const x = round(pt.x);
			const y = round(pt.y);
			parts.push(`${x - px},${y - py},${Math.round(pt.p * 100)}`);
			px = x;
			py = y;
		}
		lines.push(`${stroke.color} ${stroke.width} ${parts.join(" ")}`);
	}
	return lines.join("\n");
}

export function decodeInk(raw: string): Stroke[] {
	const text = raw.trim();
	if (!text) return [];

	if (text.startsWith("[")) {
		try {
			const parsed = JSON.parse(text);
			return Array.isArray(parsed) ? (parsed as Stroke[]) : [];
		} catch {
			return [];
		}
	}

	const strokes: Stroke[] = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const fields = trimmed.split(" ");
		if (fields.length < 3) continue;
		const color = fields[0];
		const width = Number(fields[1]);
		if (!Number.isFinite(width)) continue;

		const points: InkPoint[] = [];
		let x = 0;
		let y = 0;
		for (let i = 2; i < fields.length; i++) {
			const nums = fields[i].split(",");
			if (nums.length < 3) continue;
			const dx = Number(nums[0]);
			const dy = Number(nums[1]);
			const p = Number(nums[2]);
			if (!Number.isFinite(dx) || !Number.isFinite(dy)) continue;
			x += dx;
			y += dy;
			points.push({
				x: x / COORD_SCALE,
				y: y / COORD_SCALE,
				p: Number.isFinite(p) ? p / 100 : 0.5,
			});
		}
		if (points.length) strokes.push({ color, width, points });
	}
	return strokes;
}

/** Distance from point p to segment ab, used for eraser hit-testing. */
function distanceToSegment(
	px: number,
	py: number,
	ax: number,
	ay: number,
	bx: number,
	by: number
): number {
	const dx = bx - ax;
	const dy = by - ay;
	const lenSq = dx * dx + dy * dy;
	let t = lenSq === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lenSq;
	t = Math.max(0, Math.min(1, t));
	const cx = ax + t * dx;
	const cy = ay + t * dy;
	return Math.hypot(px - cx, py - cy);
}

export function strokeHitTest(
	stroke: Stroke,
	x: number,
	y: number,
	radius: number
): boolean {
	const pts = stroke.points;
	if (pts.length === 1) {
		return Math.hypot(pts[0].x - x, pts[0].y - y) <= radius;
	}
	for (let i = 1; i < pts.length; i++) {
		if (
			distanceToSegment(x, y, pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y) <=
			radius
		) {
			return true;
		}
	}
	return false;
}

/**
 * Paint a stroke with midpoint-quadratic smoothing and pressure-varied width.
 * `scale` converts ink space to CSS pixels.
 */
export function paintStroke(
	ctx: CanvasRenderingContext2D,
	stroke: Stroke,
	scale: number,
	fromIndex = 1
): void {
	const pts = stroke.points;
	if (pts.length === 0) return;

	ctx.strokeStyle = stroke.color;
	ctx.lineCap = "round";
	ctx.lineJoin = "round";

	if (pts.length === 1) {
		ctx.fillStyle = stroke.color;
		ctx.beginPath();
		ctx.arc(
			pts[0].x * scale,
			pts[0].y * scale,
			((stroke.width * scale) / 2) * pressureFactor(pts[0].p),
			0,
			Math.PI * 2
		);
		ctx.fill();
		return;
	}

	// Painting only the newest segments keeps a long stroke from costing more
	// with every frame; `fromIndex` starts one segment early for smooth joins.
	for (let i = Math.max(1, fromIndex); i < pts.length; i++) {
		const prev = pts[i - 1];
		const cur = pts[i];
		ctx.beginPath();
		ctx.lineWidth =
			stroke.width * scale * pressureFactor((prev.p + cur.p) / 2);
		if (i === 1) {
			ctx.moveTo(prev.x * scale, prev.y * scale);
		} else {
			const before = pts[i - 2];
			ctx.moveTo(
				((before.x + prev.x) / 2) * scale,
				((before.y + prev.y) / 2) * scale
			);
		}
		ctx.quadraticCurveTo(
			prev.x * scale,
			prev.y * scale,
			((prev.x + cur.x) / 2) * scale,
			((prev.y + cur.y) / 2) * scale
		);
		ctx.stroke();
	}
}

/** Map a 0–1 pressure reading onto a sane width multiplier. */
export function pressureFactor(p: number): number {
	if (!Number.isFinite(p) || p <= 0) return 1;
	return 0.45 + p * 1.1;
}
