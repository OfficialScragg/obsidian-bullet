import { App, Modal, Notice, Setting, TFile, normalizePath } from "obsidian";
import { BulletView } from "./view";
import { serializeNote } from "./serialize";
import type BulletPlugin from "./main";

const REPORT_FILE = "Bullet ink diagnostics.md";

/**
 * Measures the things that actually cost time while drawing, on the device
 * that matters. Getting the numbers off a tablet is half the problem, so the
 * report is selectable text, copyable, and can be written into the vault.
 */
export class InkDiagnosticsModal extends Modal {
	private view: BulletView;
	private plugin: BulletPlugin;
	private report = "";

	constructor(app: App, view: BulletView, plugin: BulletPlugin) {
		super(app);
		this.view = view;
		this.plugin = plugin;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "Ink performance" });

		const ink = this.view.inkLayer;
		if (!ink) {
			contentEl.createEl("p", { text: "Open a Bullet page first." });
			return;
		}

		const canvas = ink.measure();

		const serializeStart = performance.now();
		const text = serializeNote(this.view.model, [], true);
		const serializeMs = performance.now() - serializeStart;

		const dpr = window.devicePixelRatio || 1;
		const megapixels = (canvas.backingWidth * canvas.backingHeight) / 1e6;

		const rows: [string, string][] = [
			[
				"Pen down to ink on screen",
				canvas.samples
					? `${canvas.firstPaintMs.toFixed(1)} ms avg, ${canvas.worstFirstPaintMs.toFixed(1)} ms worst (${canvas.samples} strokes)`
					: "draw a few strokes first, then reopen this",
			],
			[
				"Gap between drawing frames",
				canvas.frameIntervalMs
					? `${canvas.frameIntervalMs.toFixed(1)} ms avg, ${canvas.worstFrameIntervalMs.toFixed(1)} ms worst`
					: "n/a",
			],
			["Work per drawing frame", `${canvas.frameMs.toFixed(2)} ms`],
			["Strokes on the page", String(canvas.strokes)],
			["Points on the page", String(canvas.points)],
			["Canvas (CSS px)", `${canvas.cssWidth} x ${canvas.cssHeight}`],
			[
				"Canvas (device px)",
				`${canvas.backingWidth} x ${canvas.backingHeight} = ${megapixels.toFixed(1)} MP at dpr ${dpr}`,
			],
			["240 x getBoundingClientRect", `${canvas.rectMs.toFixed(1)} ms`],
			["Paint one frame of ink", `${canvas.paintMs.toFixed(2)} ms`],
			["Full redraw of every stroke", `${canvas.redrawMs.toFixed(1)} ms`],
			["Serialise the page", `${serializeMs.toFixed(1)} ms`],
			["Page size on disk", `${(text.length / 1024).toFixed(1)} KB`],
			[
				"Page rebuilt since opening",
				`${this.view.renderLog.length}x  ${this.view.renderLog.slice(-8).join(" ")}`,
			],
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

		contentEl.createEl("p", {
			text: "Draw a stroke that fails, then open this straight away — the pointer log at the bottom of the report shows what the plugin was handed and what it did with it.",
			cls: "setting-item-description",
		});

		const trace = ink.getTrace();
		this.report = [
			`Bullet ${this.plugin.manifest.version} — ink diagnostics`,
			...rows.map(([label, value]) => `${label}: ${value}`),
			`Platform: ${navigator.userAgent}`,
			"",
			"Pointer log (newest last):",
			...(trace.length ? trace.slice(-45) : ["(nothing recorded)"]),
		].join("\n");

		// A textarea so the text can be selected on a tablet, where a copy
		// button alone is easy to have refused by the clipboard permission.
		const box = contentEl.createEl("textarea", { cls: "bl-report" });
		box.value = this.report;
		box.readOnly = true;
		box.rows = 6;
		box.style.width = "100%";
		box.style.fontFamily = "var(--font-monospace)";
		box.style.fontSize = "0.75em";

		new Setting(contentEl)
			.addButton((b) =>
				b
					.setButtonText("Copy")
					.setCta()
					.onClick(async () => {
						try {
							await navigator.clipboard.writeText(this.report);
							new Notice("Diagnostics copied");
						} catch {
							box.select();
							new Notice("Select the text above and copy it");
						}
					})
			)
			.addButton((b) =>
				b.setButtonText("Save to vault").onClick(async () => {
					try {
						const path = normalizePath(REPORT_FILE);
						const existing = this.app.vault.getAbstractFileByPath(path);
						if (existing instanceof TFile) {
							await this.app.vault.modify(existing, this.report);
						} else {
							await this.app.vault.create(path, this.report);
						}
						new Notice(`Saved to ${path}`);
					} catch (err) {
						console.error("Bullet: could not save diagnostics", err);
						new Notice("Could not save the report");
					}
				})
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
