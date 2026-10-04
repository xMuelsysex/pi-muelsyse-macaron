import { InteractiveMode, type Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { renderMacaronContentGradient } from "./gradient";
import { installPrototypePatch } from "./prototype-patch-registry";

/**
 * Cockpit renders its agent/session bar into the host widget slot above the editor
 * (`cockpit-session-bar`), so the pack styles that bar by wrapping the widget slot instead of
 * patching Cockpit: Cockpit updates keep the gradient, and a renamed key only costs the
 * gradient, never an error.
 *
 * Pi runs `session_start` handlers in extension load order, so wrapping `ctx.ui.setWidget` there
 * only covers mounts that happen after the pack's own handler: with Cockpit's package listed
 * before the pack (the live settings do), Cockpit mounts the bar first and an idle session never
 * re-mounts it. Patching the host mount point the facade forwards to, while the pack loads, is
 * in place before every `session_start` — load order no longer decides whether the bar is styled.
 */
const COCKPIT_BAR_WIDGET_KEY = "cockpit-session-bar";
const WIDGET_SLOT_METHOD = "setExtensionWidget";

type WidgetComponent = Component & { dispose?(): void };
type WidgetFactory = (tui: TUI, theme: Theme) => WidgetComponent;

/** Render wrappers handed out since the last release; session teardown drops them. */
const decorations = new Set<() => void>();

/** Restore the `render` of every bar component decorated so far. */
export function releaseCockpitBarDecorations(): void {
	for (const release of decorations) release();
	decorations.clear();
}

function decorate(component: WidgetComponent): void {
	decorations.add(
		installPrototypePatch(component, "render", "cockpit-bar-render", ({ predecessor, receiver, args }) => {
			const lines = Reflect.apply(predecessor, receiver, args);
			return Array.isArray(lines)
				? lines.map((line: unknown) => (typeof line === "string" ? renderMacaronContentGradient(line) : line))
				: lines;
		}),
	);
}

/**
 * Patch the host's widget mount point. The default target is the class the extension UI facade
 * forwards to; tests pass a stand-in object. Returns the cleanup that removes the patch.
 */
export function installCockpitBarGradient(slot: object = InteractiveMode.prototype): () => void {
	if (typeof (slot as Record<string, unknown>)[WIDGET_SLOT_METHOD] !== "function") return () => {};
	return installPrototypePatch(slot, WIDGET_SLOT_METHOD, "cockpit-bar-slot", ({ predecessor, receiver, args }) => {
		const [key, content, options] = args as [unknown, unknown, unknown];
		if (typeof content !== "function" || key !== COCKPIT_BAR_WIDGET_KEY) {
			return Reflect.apply(predecessor, receiver, args);
		}
		const factory = content as WidgetFactory;
		return Reflect.apply(predecessor, receiver, [
			key,
			(tui: TUI, theme: Theme) => {
				const component = factory(tui, theme);
				decorate(component);
				return component;
			},
			options,
		]);
	});
}
