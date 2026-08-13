import { INK_SPACE, paintStroke, strokeHitTest } from "./ink";
import { InkPoint, Stroke } from "./types";

export type InkMode = "off" | "draw" | "erase";

export interface InkLayerOptions {
	fingerDraw: boolean;
	color: string;
	width: number;
	/** Upper bound on the canvas backing-store scale. */
	maxDpr: number;
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

	/** Canvas origin in client space, cached — see toInk(). */
	private originX = 0;
	private originY = 0;

	/** Points captured since the last animation frame. */
	private pending: InkPoint[] = [];
	private frameHandle = 0;

	/** Timing of recent strokes, for the diagnostics command. */
	private strokeStartedAt = 0;
	private firstPaintMs: number[] = [];
	private frameMs: number[] = [];
	private observedTarget: HTMLElement | null = null;

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
		// Stop iPadOS turning a long press into a text-selection loupe.
		this.canvas.addEventListener("contextmenu", (e) => {
			if (this.mode !== "off") e.preventDefault();
		});

		this.applyMode();
	}

	// -- lifecycle ---------------------------------------------------------

	observe(target: HTMLElement, scroller: HTMLElement | null): void {
		this.observedTarget = target;
		this.pageScroller = scroller;
		this.resizeObserver = new ResizeObserver(() => this.resize(target));
		this.resizeObserver.observe(target);
		this.resize(target);
	}

	destroy(): void {
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		if (this.frameHandle) cancelAnimationFrame(this.frameHandle);
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

	/** Numbers for the diagnostics command. */
	measure(): {
		strokes: number;
		points: number;
		cssWidth: number;
		cssHeight: number;
		backingWidth: number;
		backingHeight: number;
		rectMs: number;
		paintMs: number;
		redrawMs: number;
		firstPaintMs: number;
		worstFirstPaintMs: number;
		frameMs: number;
		samples: number;
	} {
		const points = this.strokes.reduce((n, s) => n + s.points.length, 0);

		// What the old code did once per input point.
		const rectStart = performance.now();
		for (let i = 0; i < 240; i++) this.canvas.getBoundingClientRect();
		const rectMs = performance.now() - rectStart;

		// A frame's worth of segments at the current canvas size.
		const probe: Stroke = {
			color: this.opts.color,
			width: this.opts.width,
			points: [],
		};
		for (let i = 0; i < 8; i++) {
			probe.points.push({ x: 20 + i * 3, y: 20 + (i % 2) * 3, p: 0.5 });
		}
		const paintStart = performance.now();
		for (let i = 0; i < 60; i++) paintStroke(this.ctx, probe, this.scale);
		const paintMs = (performance.now() - paintStart) / 60;

		const redrawStart = performance.now();
		this.redraw();
		const redrawMs = performance.now() - redrawStart;

		const mean = (xs: number[]) =>
			xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;

		return {
			firstPaintMs: mean(this.firstPaintMs),
			worstFirstPaintMs: this.firstPaintMs.length
				? Math.max(...this.firstPaintMs)
				: 0,
			frameMs: mean(this.frameMs),
			samples: this.firstPaintMs.length,
			strokes: this.strokes.length,
			points,
			cssWidth: Math.round(this.cssWidth),
			cssHeight: Math.round(this.cssHeight),
			backingWidth: this.canvas.width,
			backingHeight: this.canvas.height,
			rectMs,
			paintMs,
			redrawMs,
		};
	}

	/** True while a pen or mouse is actually laying down ink. */
	isDrawing(): boolean {
		return this.activePointerId !== null;
	}

	/** Cap the canvas backing store; lower is cheaper to push around. */
	setMaxDpr(maxDpr: number): void {
		if (this.opts.maxDpr === maxDpr) return;
		this.opts = { ...this.opts, maxDpr };
		if (this.observedTarget) {
			this.cssWidth = -1;
			this.resize(this.observedTarget);
		}
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

		const dpr = Math.min(window.devicePixelRatio || 1, this.opts.maxDpr || MAX_DPR);
		this.canvas.width = Math.floor(width * dpr);
		this.canvas.height = Math.floor(height * dpr);
		this.canvas.style.width = `${width}px`;
		this.canvas.style.height = `${height}px`;
		this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		this.refreshOrigin();
		this.redraw();
	}

	/**
	 * Re-read where the canvas sits. getBoundingClientRect() forces the browser
	 * to flush layout, so this must never be called per point: an Apple Pencil
	 * reports around 240 points a second, and doing it per point meant hundreds
	 * of forced layouts a second against the whole page. Once per stroke, and
	 * on resize, is enough — the canvas only moves when the pane does.
	 */
	private refreshOrigin(): void {
		const rect = this.canvas.getBoundingClientRect();
		this.originX = rect.left;
		this.originY = rect.top;
	}

	private toInk(e: PointerEvent | { clientX: number; clientY: number }): InkPoint {
		return {
			x: (e.clientX - this.originX) / this.scale,
			y: (e.clientY - this.originY) / this.scale,
			p: "pointerType" in e ? pressureOf(e as PointerEvent) : 0.5,
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
		// Capture is an optimisation, not a requirement. It throws if the
		// pointer has already gone, and letting that escape would abandon the
		// stroke before it starts.
		this.capture(e.pointerId);
		this.refreshOrigin();
		this.pending.length = 0;
		this.strokeStartedAt = performance.now();

		const point = this.toInk(e);

		if (this.mode === "erase") {
			this.eraseAt(point.x, point.y);
			return;
		}

		this.active = {
			color: this.opts.color,
			width: this.opts.width,
			points: [point],
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

		// Collect here and draw on the next frame. Drawing inline meant doing
		// canvas work several times per frame and holding up the input queue,
		// which is what the pen felt as lag.
		const coalesced =
			typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [];
		const events = coalesced.length ? coalesced : [e];
		for (const ev of events) this.pending.push(this.toInk(ev));

		if (!this.frameHandle) {
			this.frameHandle = requestAnimationFrame(this.renderFrame);
		}
	};

	private renderFrame = (): void => {
		this.frameHandle = 0;
		const points = this.pending;
		if (points.length === 0) return;
		this.pending = [];
		const frameStart = performance.now();

		if (this.mode === "erase") {
			for (const point of points) this.eraseAt(point.x, point.y);
			return;
		}
		if (!this.active) return;

		const stroke = this.active;
		const startedAt = stroke.points.length;
		for (const point of points) {
			const last = stroke.points[stroke.points.length - 1];
			// Drop sub-pixel jitter; it bloats the stored stroke for nothing.
			if (last && Math.hypot(point.x - last.x, point.y - last.y) < 0.25) continue;
			stroke.points.push(point);
		}
		if (stroke.points.length === startedAt) return;

		paintStroke(this.ctx, stroke, this.scale, Math.max(1, startedAt - 1));

		if (this.strokeStartedAt) {
			// How long the pen was down before its ink first appeared.
			this.firstPaintMs.push(performance.now() - this.strokeStartedAt);
			if (this.firstPaintMs.length > 40) this.firstPaintMs.shift();
			this.strokeStartedAt = 0;
		}
		this.frameMs.push(performance.now() - frameStart);
		if (this.frameMs.length > 60) this.frameMs.shift();
	};

	private onPointerUp = (e: PointerEvent): void => {
		if (this.panPointerId === e.pointerId) {
			this.endPan();
			return;
		}
		if (this.activePointerId !== e.pointerId) return;

		// Take whatever the last frame didn't get to.
		if (this.frameHandle) {
			cancelAnimationFrame(this.frameHandle);
			this.frameHandle = 0;
		}
		this.renderFrame();

		this.activePointerId = null;
		this.release(e.pointerId);

		if (this.mode === "erase") {
			this.opts.onChange();
			return;
		}
		if (!this.active) return;

		const finished = this.active;
		this.active = null;
		if (finished.points.length > 0) {
			this.strokes.push(finished);
			// A tap, or a flick too small to clear the jitter filter, never
			// reached renderFrame — paint it here or it simply never appears.
			if (finished.points.length < 2) {
				paintStroke(this.ctx, finished, this.scale);
			}
			this.opts.onChange();
		}
	};

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

	private capture(pointerId: number): void {
		try {
			this.canvas.setPointerCapture(pointerId);
		} catch {
			/* the pointer is already gone; carry on without capture */
		}
	}

	private release(pointerId: number): void {
		try {
			if (this.canvas.hasPointerCapture(pointerId)) {
				this.canvas.releasePointerCapture(pointerId);
			}
		} catch {
			/* already released */
		}
	}

	private beginPan(e: PointerEvent): void {
		this.scroller = this.scrollableUnder(e.clientX, e.clientY);
		if (!this.scroller) return;
		this.stopPan();
		this.panPointerId = e.pointerId;
		this.panLastY = e.clientY;
		this.panLastTime = performance.now();
		this.panVelocity = 0;
		this.capture(e.pointerId);
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
		if (this.panPointerId !== null) this.release(this.panPointerId);
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
