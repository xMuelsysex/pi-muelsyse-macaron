import assert from "node:assert/strict";
import { test } from "node:test";
import {
	installStatusLineSlot,
	isZentuiStatusLineFactory,
	markZentuiStatusLineFactory,
	type StatusLineFactory,
} from "../extensions/zentui/status-line-slot";

/** Host mount-point stand-in: records which factories reach the single footer slot. */
function makeSlot() {
	const mounted: unknown[] = [];
	const original = (factory: unknown) => {
		mounted.push(factory);
	};
	const slot = { setExtensionFooter: original };
	return {
		slot,
		mounted,
		mount: (factory: unknown) => (slot.setExtensionFooter as (value: unknown) => void)(factory),
		original,
	};
}

const own = () => markZentuiStatusLineFactory((() => undefined) as unknown as StatusLineFactory);
const foreign = () => ((() => undefined) as unknown as StatusLineFactory);

test("the pack's own footer reaches the host slot whatever the ownership", () => {
	const { slot, mounted, mount, original } = makeSlot();
	const factory = own();
	const cleanup = installStatusLineSlot({
		holdsSlot: () => true,
		rememberForeignFactory: () => {},
		slot,
	});

	mount(factory);
	mount(undefined);
	assert.deepEqual(mounted, [factory, undefined], "own factories and slot clearing pass through");
	assert.equal(isZentuiStatusLineFactory(factory), true);
	assert.equal(isZentuiStatusLineFactory(foreign()), false);

	cleanup();
	assert.equal(slot.setExtensionFooter, original, "cleanup restores the host method");
});

test("another extension's footer is held back while the pack owns the slot, and handed back on request", () => {
	const { slot, mounted, mount } = makeSlot();
	let owns = true;
	const remembered: unknown[] = [];
	const cleanup = installStatusLineSlot({
		holdsSlot: () => owns,
		rememberForeignFactory: (factory) => remembered.push(factory),
		slot,
	});

	const openTui = foreign();
	mount(openTui);
	assert.deepEqual(mounted, [], "the foreign footer never mounts while the pack owns the slot");
	assert.deepEqual(remembered, [openTui], "the rejected factory is kept for handing the slot back");

	// 交还底栏：判定变 false 后，同一个工厂原样装回槽位。
	owns = false;
	mount(remembered[0]);
	assert.deepEqual(mounted, [openTui]);

	// 之后的重新安装（例如下一次 session_start）正常进入槽位。
	const again = foreign();
	mount(again);
	assert.deepEqual(mounted, [openTui, again]);
	cleanup();
});

test("a mount point without the host method is left alone", () => {
	const cleanup = installStatusLineSlot({
		holdsSlot: () => true,
		rememberForeignFactory: () => {},
		slot: {},
	});
	assert.equal(typeof cleanup, "function");
	cleanup();
});
