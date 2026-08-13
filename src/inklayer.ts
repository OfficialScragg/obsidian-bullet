import { INK_SPACE, paintStroke, strokeHitTest } from "./ink";
import { InkPoint, Stroke } from "./types";

export type InkMode = "off" | "draw" | "erase";

export interface InkLayerOptions {
	fingerDraw: boolean;
	color: string;
	width: number;
	onChange: () => void;
}

const MAX_DPR = 2;
const ERASER_RADIUS = 9; // in ink-space units
const SCROLL_FRICTION = 0.94;

/**
 * The handwriting layer. Sits over the whole page; transparent and
 * pointer-transparent while typing, live while drawing.
 *
 * On iPad the surface takes `touch-action: none` whenever it is live, because
 * anything looser lets iPadOS scroll the page out from under an Apple Pencil
 * stroke. Finger scrolling is therefore re-implemented here: a one-finger drag
 * pans the scroll container and keeps a little momentum afterwards.
 */
export class InkLayer {
	readonly canvas: HTMLCanvasElement;

	private ctx: CanvasRenderingContext2D;
	private strokes: Stroke[] = [];
	private redoStack: Stroke[] = [];
	private active: Stroke | null = null;
	private activePointerId: number | null = null;

	private mode: InkMode = "off";
	private opts: InkLayerOptions;

	private cssWidth = 1;
	private cssHeight = 1;
	private scale = 1;
	private resizeObserver: ResizeObserver | null = null;

	/** The outer page scroller, used when nothing nearer can scroll. */
	private pageScroller: HTMLElement | null = null;
	/** The element the current finger drag is actually panning. */
	private scroller: HTMLElement | null = null;
	private panPointerId: number | null = null;
	private panLastY = 0;
	private panVelocity = 0;
	private panFrame = 0;
	private panLastTime = 0;

	constructor(parent: HTMLElement, opts: InkLayerOptions) {
		this.opts = opts;
		this.canvas = parent.createEl("canvas", { cls: "bl-ink-canvas" });
		const ctx = this.canvas.getContext("2d");
		if (!ctx) throw new Error("Bullet: unable to get a 2D canvas context");
		this.ctx = ctx;

		this.canvas.addEventListener("pointerdown", this.onPointerDown);
		this.canvas.addEventListener("pointermove", this.onPointerMove);
		this.canvas.addEventListener("pointerup", this.onPointerUp);
		this.canvas.addEventListener("pointercancel", this.onPointerUp);
		this.canvas.addEventListener("pointerleave", this.onPointerUp);
		// Stop iPadOS turning a long press into a text-selection loupe.
		this.canvas.addEventListener("contextmenu", (e) => {
			if (this.mode !== "off") e.preventDefault();
		});

		this.applyMode();
	}

	// -- lifecycle ---------------------------------------------------------

	observe(target: HTMLElement, scroller: HTMLElement | null): void {
		this.pageScroller = scroller;
		this.resizeObserver = new ResizeObserver(() => this.resize(target));
		this.resizeObserver.observe(target);
		this.resize(target);
	}

	destroy(): void {
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		if (this.panFrame) cancelAnimationFrame(this.panFrame);
		this.canvas.remove();
	}

	// -- state -------------------------------------------------------------

	setStrokes(strokes: Stroke[]): void {
		this.strokes = strokes;
		this.redoStack = [];
		this.redraw();
	}

	getStrokes(): Stroke[] {
		return this.strokes;
	}

	setMode(mode: InkMode): void {
		this.mode = mode;
		this.applyMode();
	}

	getMode(): InkMode {
		return this.mode;
	}

	setOptions(partial: Partial<InkLayerOptions>): void {
		this.opts = { ...this.opts, ...partial };
	}

	canUndo(): boolean {
		return this.strokes.length > 0;
	}

	canRedo(): boolean {
		return this.redoStack.length > 0;
	}

	undo(): void {
		const popped = this.strokes.pop();
		if (!popped) return;
		this.redoStack.push(popped);
		this.redraw();
		this.opts.onChange();
	}

	redo(): void {
		const restored = this.redoStack.pop();
		if (!restored) return;
		this.strokes.push(restored);
		this.redraw();
		this.opts.onChange();
	}

	clear(): void {
		if (this.strokes.length === 0) return;
		this.redoStack = this.strokes.slice().reverse();
		this.strokes = [];
		this.redraw();
		this.opts.onChange();
	}

	private applyMode(): void {
		const live = this.mode !== "off";
		this.canvas.toggleClass("is-live", live);
		this.canvas.style.pointerEvents = live ? "auto" : "none";
		this.canvas.style.touchAction = live ? "none" : "auto";
		this.canvas.style.cursor = this.mode === "erase" ? "cell" : live ? "crosshair" : "";
	}

	// -- geometry ----------------------------------------------------------

	private resize(target: HTMLElement): void {
		const width = target.clientWidth;
		const height = target.clientHeight;
		if (width <= 0 || height <= 0) return;
		if (width === this.cssWidth && height === this.cssHeight) return;

		this.cssWidth = width;
		this.cssHeight = height;
		this.scale = width / INK_SPACE;

		const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
		this.canvas.width = Math.floor(width * dpr);
		this.canvas.height = Math.floor(height * dpr);
		this.canvas.style.width = `${width}px`;
		this.canvas.style.height = `${height}px`;
		this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		this.redraw();
	}

	private toInk(e: PointerEvent): { x: number; y: number } {
		const rect = this.canvas.getBoundingClientRect();
		return {
			x: (e.clientX - rect.left) / this.scale,
			y: (e.clientY - rect.top) / this.scale,
		};
	}

	private redraw(): void {
		this.ctx.clearRect(0, 0, this.cssWidth, this.cssHeight);
		for (const stroke of this.strokes) paintStroke(this.ctx, stroke, this.scale);
	}

	// -- input -------------------------------------------------------------

	private isDrawingPointer(e: PointerEvent): boolean {
		if (e.pointerType === "pen") return true;
		if (e.pointerType === "mouse") return true;
		return this.opts.fingerDraw;
	}

	private onPointerDown = (e: PointerEvent): void => {
		if (this.mode === "off") return;

		if (!this.isDrawingPointer(e)) {
			this.beginPan(e);
			return;
		}
		// A pen touching down cancels any momentum still running.
		this.stopPan();

		e.preventDefault();
		this.activePointerId = e.pointerId;
		this.canvas.setPointerCapture(e.pointerId);

		const { x, y } = this.toInk(e);

		if (this.mode === "erase") {
			this.eraseAt(x, y);
			return;
		}

		this.active = {
			color: this.opts.color,
			width: this.opts.width,
			points: [{ x, y, p: pressureOf(e) }],
		};
		this.redoStack = [];
	};

	private onPointerMove = (e: PointerEvent): void => {
		if (this.mode === "off") return;

		if (this.panPointerId === e.pointerId) {
			this.movePan(e);
			return;
		}
		if (this.activePointerId !== e.pointerId) return;
		e.preventDefault();

		const events =
			typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [e];

		if (this.mode === "erase") {
			for (const ev of events.length ? events : [e]) {
				const { x, y } = this.toInk(ev);
				this.eraseAt(x, y);
			}
			return;
		}
		if (!this.active) return;

		for (const ev of events.length ? events : [e]) {
			const { x, y } = this.toInk(ev);
			const points = this.active.points;
			const last = points[points.length - 1];
			// Drop sub-pixel jitter; it bloats the stored stroke for nothing.
			if (last && Math.hypot(x - last.x, y - last.y) < 0.4) continue;
			points.push({ x, y, p: pressureOf(ev) });
		}
		this.paintActiveTail();
	};

	private onPointerUp = (e: PointerEvent): void => {
		if (this.panPointerId === e.pointerId) {
			this.endPan();
			return;
		}
		if (this.activePointerId !== e.pointerId) return;

		this.activePointerId = null;
		if (this.canvas.hasPointerCapture(e.pointerId)) {
			this.canvas.releasePointerCapture(e.pointerId);
		}

		if (this.mode === "erase") {
			this.opts.onChange();
			return;
		}
		if (!this.active) return;

		const finished = this.active;
		this.active = null;
		if (finished.points.length > 0) {
			this.strokes.push(finished);
			this.redraw();
			this.opts.onChange();
		}
	};

	/** Draw only the newest couple of segments, so long strokes stay smooth. */
	private paintActiveTail(): void {
		if (!this.active) return;
		const points = this.active.points;
		if (points.length < 2) return;
		const tail: Stroke = {
			color: this.active.color,
			width: this.active.width,
			points: points.slice(Math.max(0, points.length - 4)),
		};
		paintStroke(this.ctx, tail, this.scale);
	}

	private eraseAt(x: number, y: number): void {
		const before = this.strokes.length;
		this.strokes = this.strokes.filter(
			(s) => !strokeHitTest(s, x, y, ERASER_RADIUS)
		);
		if (this.strokes.length !== before) this.redraw();
	}

	// -- finger panning ----------------------------------------------------

	/**
	 * The panel under the finger, not just the outer page: each card scrolls on
	 * its own now, and the canvas sits over all of them.
	 */
	private scrollableUnder(x: number, y: number): HTMLElement | null {
		const previous = this.canvas.style.pointerEvents;
		this.canvas.style.pointerEvents = "none";
		let node = document.elementFromPoint(x, y) as HTMLElement | null;
		this.canvas.style.pointerEvents = previous;

		while (node) {
			const overflow = getComputedStyle(node).overflowY;
			if (
				(overflow === "auto" || overflow === "scroll") &&
				node.scrollHeight > node.clientHeight + 1
			) {
				return node;
			}
			node = node.parentElement;
		}
		return this.pageScroller;
	}

	private beginPan(e: PointerEvent): void {
		this.scroller = this.scrollableUnder(e.clientX, e.clientY);
		if (!this.scroller) return;
		this.stopPan();
		this.panPointerId = e.pointerId;
		this.panLastY = e.clientY;
		this.panLastTime = performance.now();
		this.panVelocity = 0;
		this.canvas.setPointerCapture(e.pointerId);
	}

	private movePan(e: PointerEvent): void {
		if (!this.scroller) return;
		const now = performance.now();
		const dy = e.clientY - this.panLastY;
		const dt = Math.max(1, now - this.panLastTime);
		this.scroller.scrollTop -= dy;
		this.panVelocity = dy / dt;
		this.panLastY = e.clientY;
		this.panLastTime = now;
	}

	private endPan(): void {
		if (this.panPointerId !== null && this.canvas.hasPointerCapture(this.panPointerId)) {
			this.canvas.releasePointerCapture(this.panPointerId);
		}
		this.panPointerId = null;

		const scroller = this.scroller;
		if (!scroller) return;
		let velocity = this.panVelocity * 16;
		const step = () => {
			velocity *= SCROLL_FRICTION;
			if (Math.abs(velocity) < 0.4) {
				this.panFrame = 0;
				return;
			}
			scroller.scrollTop -= velocity;
			this.panFrame = requestAnimationFrame(step);
		};
		this.panFrame = requestAnimationFrame(step);
	}

	private stopPan(): void {
		if (this.panFrame) {
			cancelAnimationFrame(this.panFrame);
			this.panFrame = 0;
		}
		this.panVelocity = 0;
	}
}

function pressureOf(e: PointerEvent): number {
	// Mice report a flat 0.5, and some pens report 0 on the very first sample.
	if (e.pointerType === "mouse") return 0.5;
	return e.pressure > 0 ? e.pressure : 0.5;
}

export type { InkPoint };
