import { InteractiveMode, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { installPrototypePatch } from "./prototype-patch-registry";

export type StatusLineFactory = NonNullable<Parameters<ExtensionContext["ui"]["setFooter"]>[0]>;

/** Pack-unique marker so our own factories are recognised whatever the load order. */
const ZENTUI_STATUS_LINE_FACTORY = Symbol.for(
	"pi-muelsyse-macaron.zentui.status-line-factory",
);

type ZentuiStatusLineFactory = StatusLineFactory & { [ZENTUI_STATUS_LINE_FACTORY]?: true };

export function markZentuiStatusLineFactory<T extends StatusLineFactory>(factory: T): T {
	(factory as ZentuiStatusLineFactory)[ZENTUI_STATUS_LINE_FACTORY] = true;
	return factory;
}

export function isZentuiStatusLineFactory(factory: StatusLineFactory): boolean {
	return (factory as ZentuiStatusLineFactory)[ZENTUI_STATUS_LINE_FACTORY] === true;
}

const SLOT_METHOD = "setExtensionFooter";

export type StatusLineSlotOptions = {
	/** True while this pack keeps the host footer slot: footers from other extensions are rejected. */
	holdsSlot: () => boolean;
	/** Every footer another extension asks the host to mount, so the choice can be handed back. */
	rememberForeignFactory: (factory: StatusLineFactory) => void;
	/** Host mount point; tests pass a stand-in object. */
	slot?: object;
};

/**
 * Pi has a single footer slot and the last `ctx.ui.setFooter` wins, so which extension draws the
 * bottom line would otherwise depend on the load order. While this pack owns the slot, the mount
 * point rejects foreign footers — and hands the rejected factory to the caller, because extensions
 * such as pi-open-tui install once per session and never re-install on their own.
 */
export function installStatusLineSlot(options: StatusLineSlotOptions): () => void {
	const target = options.slot ?? InteractiveMode.prototype;
	if (typeof (target as Record<string, unknown>)[SLOT_METHOD] !== "function") return () => {};
	return installPrototypePatch(target, SLOT_METHOD, "status-line-slot", ({ predecessor, receiver, args }) => {
		const [factory] = args as [unknown];
		if (typeof factory !== "function" || isZentuiStatusLineFactory(factory as StatusLineFactory)) {
			return Reflect.apply(predecessor, receiver, args);
		}
		options.rememberForeignFactory(factory as StatusLineFactory);
		if (!options.holdsSlot()) return Reflect.apply(predecessor, receiver, args);
		return undefined;
	});
}
