import { App, Modal, Notice, Setting } from "obsidian";
import { BulletView } from "./view";
import { serializeNote } from "./serialize";

/**
 * Measures the things that actually cost time while drawing, in the
 * environment that matters — the user's own device — so tuning is based on
 * numbers rather than on guesses about which step is slow.
 */
export class InkDiagnosticsModal extends Modal {
	private view: BulletView;
	private report = "";

	constructor(app: App, view: BulletView) {
		super(app);
		this.view = view;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "Ink performance" });
		contentEl.createEl("p", {
			text: "Write a line or two first, then run this — the latency figures come from the strokes you just drew.",
			cls: "setting-item-description",
		});

		const ink = this.view.inkLayer;
		if (!ink) {
			contentEl.createEl("p", { text: "Open a Bullet page first." });
			return;
		}

		const canvas = ink.measure();

		// How long it takes to write the page out — this runs on every save.
		const serializeStart = performance.now();
		const text = serializeNote(this.view.model, [], true);
		const serializeMs = performance.now() - serializeStart;

		const dpr = window.devicePixelRatio || 1;
		const megapixels = (canvas.backingWidth * canvas.backingHeight) / 1e6;

		const rows: [string, string][] = [
			["Strokes on the page", String(canvas.strokes)],
			["Points on the page", String(canvas.points)],
			["Canvas (CSS px)", `${canvas.cssWidth} x ${canvas.cssHeight}`],
			[
				"Canvas (device px)",
				`${canvas.backingWidth} x ${canvas.backingHeight} — ${megapixels.toFixed(1)} MP at dpr ${dpr}`,
			],
			[
				"Pen down to ink on screen",
				canvas.samples
					? `${canvas.firstPaintMs.toFixed(1)} ms average, ${canvas.worstFirstPaintMs.toFixed(1)} ms worst (${canvas.samples} strokes)`
					: "draw a few strokes, then run this again",
			],
			["Work per drawing frame", `${canvas.frameMs.toFixed(2)} ms`],
			["240 x getBoundingClientRect", `${canvas.rectMs.toFixed(1)} ms`],
			["Paint one frame of ink", `${canvas.paintMs.toFixed(2)} ms`],
			["Full redraw of every stroke", `${canvas.redrawMs.toFixed(1)} ms`],
			["Serialise the page", `${serializeMs.toFixed(1)} ms`],
			["Page size on disk", `${(text.length / 1024).toFixed(1)} KB`],
		];

		const table = contentEl.createEl("table");
		table.style.width = "100%";
		for (const [label, value] of rows) {
			const tr = table.createEl("tr");
			tr.createEl("td", { text: label }).style.paddingRight = "1em";
			const td = tr.createEl("td", { text: value });
			td.style.fontFamily = "var(--font-monospace)";
			td.style.textAlign = "right";
		}

		this.report = [
			"Bullet ink diagnostics",
			...rows.map(([label, value]) => `${label}: ${value}`),
			`Platform: ${navigator.userAgent}`,
		].join("\n");

		contentEl.createEl("p", {
			text: "A frame budget is 16 ms at 60 Hz, or 8 ms at 120 Hz. Anything above that while drawing is what you feel as lag.",
			cls: "setting-item-description",
		});

		new Setting(contentEl).addButton((b) =>
			b
				.setButtonText("Copy report")
				.setCta()
				.onClick(async () => {
					await navigator.clipboard.writeText(this.report);
					new Notice("Diagnostics copied");
				})
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
