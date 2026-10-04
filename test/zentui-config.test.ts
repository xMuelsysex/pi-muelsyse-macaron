import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	defaultConfig,
	getExtensionStatusColorMode,
	getExtensionStatusPlacement,
	loadConfigWithDiagnostics,
	mergeConfig,
	removeLegacyFixedEditorConfig,
	saveAnimationsPatch,
	saveExtensionStatusPlacement,
	saveStatusLineOwnerPatch,
	saveUiFeaturesPatch,
} from "../extensions/zentui/config";
import { collectExtensionStatusSegments } from "../extensions/zentui/extension-status";
import { isSupportedColorSpec } from "../extensions/zentui/style";

const THEME_MODIFIERS = new Set(["bold", "italic", "underline"]);

function tempConfig(content?: string): string {
	const path = join(mkdtempSync(join(tmpdir(), "zentui-config-")), "zentui.json");
	if (content !== undefined) writeFileSync(path, content);
	return path;
}

test("defaults have a single source of truth", () => {
	assert.deepEqual(mergeConfig({}), defaultConfig);
	assert.deepEqual(mergeConfig(undefined), defaultConfig);
	assert.equal(defaultConfig.projectRefreshIntervalMs, 60_000);
	assert.equal(defaultConfig.footerFormat, "");
	assert.equal(defaultConfig.icons.mode, "auto");
	assert.equal(defaultConfig.icons.rail, "│");
	assert.equal(defaultConfig.icons.editorPrompt, "");
	assert.equal(defaultConfig.animations.footerPulse, false);
	assert.equal(defaultConfig.features.messageStyle, true);
	assert.equal(defaultConfig.colors.editorThinkingMax, "bold #FF8FA3");
	const ascii = mergeConfig({ icons: { mode: "ascii" } });
	assert.equal(ascii.icons.rail, "|");
	assert.equal(ascii.icons.editorPrompt, "");
});

test("chrome colors follow the active theme under the theme source", () => {
	const themed = mergeConfig({ colorSources: { starship: "theme", editor: "theme" } });
	assert.equal(themed.colors.cwd, "bold accent");
	assert.equal(themed.colors.contextNormal, "syntaxFunction");
	assert.equal(themed.colors.editorThinkingMax, "bold thinkingMax");
	for (const [key, value] of Object.entries(themed.colors)) {
		if (key === "editorBorder") continue;
		assert.ok(!value.includes("#"), `${key} must not pin a literal color: ${value}`);
		assert.ok(isSupportedColorSpec(value), `${key} must be a supported style: ${value}`);
	}

	const branded = mergeConfig({ colorSources: { starship: "terminal", editor: "terminal" } });
	assert.equal(branded.colors.cwd, "bold #F2A7C6");
	assert.equal(branded.colors.editorThinkingMax, "bold #FF8FA3");

	// Every theme-source role must exist in the pack's theme, which mirrors Pi's role table
	// (scripts/check.mjs); an unknown role renders as plain text instead of a color.
	const theme = JSON.parse(
		readFileSync(new URL("../themes/muelsyse-macaron.json", import.meta.url), "utf8"),
	) as { colors: Record<string, string> };
	for (const [key, value] of Object.entries(themed.colors)) {
		for (const token of value.split(/\s+/)) {
			if (token === "" || token === "muelsyse-macaron-gradient" || THEME_MODIFIERS.has(token)) continue;
			assert.ok(token in theme.colors, `${key} must use a real theme role: ${token}`);
		}
	}

	// The two sources only differ on unset keys; an explicit value wins over both.
	const pinned = mergeConfig({ colors: { cwd: "#123456" }, colorSources: { starship: "theme" } });
	assert.equal(pinned.colors.cwd, "#123456");
	// Starship and editor sources are independent.
	const mixed = mergeConfig({ colorSources: { starship: "theme", editor: "terminal" } });
	assert.equal(mixed.colors.cwd, "bold accent");
	assert.equal(mixed.colors.editorThinkingMax, "bold #FF8FA3");
});

test("old configs with fixedEditor still load; the key is ignored", () => {
	const path = tempConfig(JSON.stringify({ fixedEditor: { enabled: true, mouseScroll: false }, separator: "dot" }));
	const loaded = loadConfigWithDiagnostics(path);
	assert.equal(loaded.problem, undefined);
	assert.equal(loaded.legacyFixedEditorEnabled, true);
	assert.equal(loaded.config.separator, "dot");
	assert.equal("fixedEditor" in loaded.config, false);
	removeLegacyFixedEditorConfig(path);
	const after = JSON.parse(readFileSync(path, "utf8"));
	assert.deepEqual(after, { separator: "dot" });
	assert.equal(loadConfigWithDiagnostics(path).legacyFixedEditorEnabled, false);
});

test("corrupt config reports the file + error, uses defaults and refuses to save", () => {
	const path = tempConfig("{ not json");
	const loaded = loadConfigWithDiagnostics(path);
	assert.ok(loaded.problem?.startsWith(path));
	assert.match(loaded.problem ?? "", /JSON/);
	assert.deepEqual(loaded.config, defaultConfig);
	assert.throws(() => saveUiFeaturesPatch({ editor: false }, path), /Refusing to save/);
	assert.equal(readFileSync(path, "utf8"), "{ not json");

	const arrayPath = tempConfig("[]");
	assert.match(loadConfigWithDiagnostics(arrayPath).problem ?? "", /JSON object/);
});

test("missing config loads defaults without a problem; saves are atomic JSON", () => {
	const path = tempConfig();
	assert.deepEqual(loadConfigWithDiagnostics(path), {
		config: defaultConfig,
		legacyFixedEditorEnabled: false,
		hasLegacyFixedEditor: false,
	});
	const saved = saveAnimationsPatch({ footerPulse: true }, path);
	assert.equal(saved.animations.footerPulse, true);
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { animations: { footerPulse: true } });
});

test("the status line owner defaults to pi-open-tui and round-trips", () => {
	assert.equal(defaultConfig.statusLineOwner, "pi-open-tui");
	assert.equal(mergeConfig({ statusLineOwner: "native" }).statusLineOwner, "native");
	assert.equal(mergeConfig({ statusLineOwner: "zentui" }).statusLineOwner, "pi-open-tui");

	const path = tempConfig();
	const saved = saveStatusLineOwnerPatch("native", path);
	assert.equal(saved.statusLineOwner, "native");
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { statusLineOwner: "native" });
	assert.throws(() => saveStatusLineOwnerPatch("zentui" as never, path), /Unsupported status line owner/);
});

test("maestro's informational statuses default to off", () => {
	for (const key of ["approval-mode", "maestro-auto-compact-mode", "maestro-effort", "mode", "self-evolve"]) {
		assert.equal(getExtensionStatusPlacement(defaultConfig, key), "off", key);
	}
	// An explicit placement in the config still wins.
	const config = mergeConfig({ extensionStatuses: { placements: { mode: "right" } } });
	assert.equal(getExtensionStatusPlacement(config, "mode"), "right");
});

test("the footer only collects statuses that are not turned off", () => {
	const statuses = new Map([
		["approval-mode", "YOLO"],
		["maestro-auto-compact-mode", "AUTO ON"],
		["maestro-effort", "max · model=global"],
		["mode", "ACT"],
		["self-evolve", "EVOL off"],
		["codex-goal", "GOAL 2/5"],
	]);
	const segments = collectExtensionStatusSegments(statuses, defaultConfig);
	assert.deepEqual(
		segments.right.map((segment) => segment.key),
		[],
		"no hidden status leaks into the right side",
	);
	assert.deepEqual(segments.left, []);
	assert.deepEqual(segments.middle.map((segment) => segment.text), ["GOAL 2/5"], "other statuses keep their placement");
});

test("extension status placements are own-property lookups (no prototype keys)", () => {
	const config = mergeConfig(
		JSON.parse(
			'{"extensionStatuses":{"placements":{"__proto__":"left","constructor":"middle","real":"off"}}}',
		),
	);
	assert.equal(getExtensionStatusPlacement(config, "constructor"), "middle");
	assert.equal(getExtensionStatusPlacement(config, "__proto__"), "left");
	assert.equal(getExtensionStatusPlacement(config, "toString"), "right");
	assert.equal(getExtensionStatusPlacement(config, "hasOwnProperty"), "right");
	assert.equal(getExtensionStatusColorMode(config, "constructor"), "zentui");
	assert.equal(getExtensionStatusColorMode(defaultConfig, "__proto__"), "zentui");
	assert.equal(getExtensionStatusPlacement(defaultConfig, "valueOf"), "right");

	const path = tempConfig("{}");
	const saved = saveExtensionStatusPlacement("__proto__", "off", path);
	assert.equal(getExtensionStatusPlacement(saved, "__proto__"), "off");
	assert.equal(getExtensionStatusPlacement(saved, "other"), "right");
});
