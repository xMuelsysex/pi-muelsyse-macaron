import { Theme, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { renderMuelsyseGradient } from "./gradient";
import { installPrototypePatch } from "./prototype-patch-registry";

type ComponentTree = Component & { children?: ComponentTree[] };
type WorkingStatusEditor = Component & { embedWorkingStatus?: boolean };
const GRADIENT_ROLES = new Set([
	"accent", "border", "borderAccent", "borderMuted", "mdLink",
	"thinkingOff", "thinkingMinimal", "thinkingLow", "thinkingMedium",
	"thinkingHigh", "thinkingXhigh", "thinkingMax",
]);

/**
 * Open TUI 的编辑器声明 `embedWorkingStatus`，宿主的 working 行就会被画进输入框上边框；
 * 本包编辑器（以及不带 Open TUI 时的默认外观）把它留在宿主的 status 行，位于雨和 agents 栏之上。
 * 两者并存时统一成后者：只关掉这个声明，宿主自行渲染指示器，其余（消息、指示帧、边框色）不变。
 */
function restoreHostWorkingLine(editor: Component): void {
	(editor as WorkingStatusEditor).embedWorkingStatus = false;
}

/** 只在插件组件的同步渲染期间改色，保留错误、警告和 Bash 模式状态色。 */
function renderWithGradient(render: () => unknown): unknown {
	const original = Theme.prototype.fg;
	Theme.prototype.fg = function (color, text) {
		return GRADIENT_ROLES.has(color)
			? renderMuelsyseGradient(text)
			: original.call(this, color, text);
	};
	try {
		return render();
	} finally {
		Theme.prototype.fg = original;
	}
}

export function installOpenTuiGradient(
	ctx: ExtensionContext,
	setRequestRender: (render: () => void) => void,
): () => void {
	let active = true;
	const cleanups: (() => void)[] = [];
	const decorated = new WeakSet<object>();
	const decorate = (component: Component) => {
		if (decorated.has(component)) return;
		decorated.add(component);
		cleanups.push(installPrototypePatch(component, "render", "open-tui-render",
			({ predecessor, receiver, args }) =>
				renderWithGradient(() => Reflect.apply(predecessor, receiver, args)),
		));
	};
	const decorateChrome = (tui: TUI) => {
		const visit = (component: ComponentTree) => {
			if (component.constructor.name === "OpenTuiHeader") decorate(component);
			for (const child of component.children ?? []) visit(child);
		};
		for (const child of tui.children) visit(child);
		// 当前 Pi 的共享组件树最后一个根节点是 footerContainer，两种 TUI 模式一致。
		const footer = tui.children.at(-1) as ComponentTree | undefined;
		for (const child of footer?.children ?? []) decorate(child);
	};
	const original = ctx.ui.setEditorComponent;
	const wrap: typeof original = (factory) => {
		original(factory && ((tui, theme, keybindings) => {
			const editor = factory(tui, theme, keybindings);
			if (active && editor.constructor.name === "OpenTuiEditor") {
				restoreHostWorkingLine(editor);
				decorate(editor);
				decorateChrome(tui);
				setRequestRender(() => tui.requestRender());
			}
			return editor;
		}));
	};
	ctx.ui.setEditorComponent = wrap;
	const factory = ctx.ui.getEditorComponent();
	if (factory) wrap(factory);
	return () => {
		active = false;
		if (ctx.ui.setEditorComponent === wrap) ctx.ui.setEditorComponent = original;
		for (const cleanup of cleanups.reverse()) cleanup();
	};
}
