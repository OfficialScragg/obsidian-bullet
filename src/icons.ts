/**
 * Bullet draws its own icons.
 *
 * Obsidian's setIcon() silently renders nothing when a name is missing from the
 * Lucide set that particular build ships, and the set differs between desktop
 * and mobile releases — which is how the whole ink toolbar ended up blank.
 * Inlining the handful we need removes the dependency entirely.
 */

const PATHS: Record<string, string> = {
	"chevron-left": '<path d="m15 18-6-6 6-6"/>',
	"chevron-right": '<path d="m9 18 6-6-6-6"/>',
	calendar:
		'<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/><path d="m9 16 2 2 4-4"/>',
	type: '<path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/>',
	pen: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
	eraser:
		'<path d="m7 21-4.3-4.3a1 1 0 0 1 0-1.4l10-10a1 1 0 0 1 1.4 0l5.6 5.6a1 1 0 0 1 0 1.4L13 21z"/><path d="M22 21H7"/>',
	undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H10"/>',
	redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H14"/>',
	trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/>',
	plus: '<path d="M12 5v14M5 12h14"/>',
	minus: '<path d="M5 12h14"/>',
	x: '<path d="M18 6 6 18M6 6l12 12"/>',
	check: '<path d="M20 6 9 17l-5-5"/>',
	file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/>',
};

/** Replace the contents of `el` with an inline SVG icon. */
export function bulletIcon(el: HTMLElement, name: string): HTMLElement {
	const path = PATHS[name];
	el.empty();
	if (!path) {
		console.warn(`Bullet: no icon named "${name}"`);
		return el;
	}

	const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	svg.setAttribute("viewBox", "0 0 24 24");
	svg.setAttribute("fill", "none");
	svg.setAttribute("stroke", "currentColor");
	svg.setAttribute("stroke-width", "2");
	svg.setAttribute("stroke-linecap", "round");
	svg.setAttribute("stroke-linejoin", "round");
	svg.setAttribute("aria-hidden", "true");
	svg.addClass("bl-svg");
	svg.innerHTML = path;
	el.appendChild(svg);
	return el;
}

/**
 * A filled dot, used for the stroke-width buttons. These were plain divs
 * coloured with `background`, which a theme can override from inside a button
 * — and did, leaving the buttons blank. An SVG inheriting `currentColor` is
 * far harder to style away by accident.
 */
export function bulletDot(el: HTMLElement, radius: number): HTMLElement {
	el.empty();
	const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	svg.setAttribute("viewBox", "0 0 24 24");
	svg.setAttribute("aria-hidden", "true");
	svg.addClass("bl-svg");
	svg.addClass("bl-svg-fill");

	const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
	circle.setAttribute("cx", "12");
	circle.setAttribute("cy", "12");
	circle.setAttribute("r", String(radius));
	svg.appendChild(circle);
	el.appendChild(svg);
	return el;
}
