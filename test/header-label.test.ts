import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// The label config path is derived from the agent dir when the module loads, so pin a
// temp agent dir before the first import. Every module here is imported lazily for that.
const agentDir = mkdtempSync(join(tmpdir(), "muelsyse-header-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.on("exit", () => rmSync(agentDir, { recursive: true, force: true }));

const label = () => import("../extensions/header/label");
const headerExtension = () => import("../extensions/header/index");
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("a label is one line of text without control characters", async () => {
  const { DEFAULT_LABEL, normalizeLabel } = await label();
  assert.equal(normalizeLabel("  MY DECK  "), "MY DECK");
  assert.equal(normalizeLabel(DEFAULT_LABEL), DEFAULT_LABEL);
  for (const bad of ["", "   ", "two\nlines", "tab\there", "\u001b[31mred", 42, undefined, null]) {
    assert.equal(normalizeLabel(bad), undefined, JSON.stringify(bad));
  }
});

test("the config file round-trips, reports unusable labels and clears cleanly", async () => {
  const { DEFAULT_LABEL, clearConfig, loadConfig, saveConfig } = await label();
  const path = join(agentDir, "header.json");

  assert.deepEqual(loadConfig(path), { config: { label: DEFAULT_LABEL } });
  assert.equal(saveConfig({ label: "MY DECK" }, path), undefined);
  assert.deepEqual(loadConfig(path), { config: { label: "MY DECK" } });
  assert.equal(JSON.parse(readFileSync(path, "utf8")).label, "MY DECK");

  writeFileSync(path, '{"label": "bad\\nlabel"}\n', "utf8");
  const unusable = loadConfig(path);
  assert.deepEqual(unusable.config, { label: DEFAULT_LABEL });
  assert.ok(unusable.error?.includes("single line"), unusable.error);

  writeFileSync(path, "{ not json", "utf8");
  assert.ok(loadConfig(path).error);

  writeFileSync(path, JSON.stringify({ label: DEFAULT_LABEL }), "utf8");
  assert.equal(clearConfig(path), undefined);
  assert.equal(clearConfig(path), undefined, "clearing a missing file is not an error");
  assert.deepEqual(loadConfig(path), { config: { label: DEFAULT_LABEL } });
});

test("subcommands parse into status, help, reset, set and invalid", async () => {
  const { DEFAULT_LABEL, describeConfig, parseHeaderCommand } = await label();
  assert.deepEqual(parseHeaderCommand(""), { type: "status" });
  assert.deepEqual(parseHeaderCommand("  STATUS "), { type: "status" });
  assert.deepEqual(parseHeaderCommand("help"), { type: "help" });
  assert.deepEqual(parseHeaderCommand("reset"), { type: "reset" });
  assert.deepEqual(parseHeaderCommand("MY DECK"), { type: "set", label: "MY DECK" });
  assert.deepEqual(parseHeaderCommand('"MY DECK"'), { type: "set", label: "MY DECK" });
  assert.deepEqual(parseHeaderCommand("'MY DECK'"), { type: "set", label: "MY DECK" });
  assert.equal(parseHeaderCommand("bad\tlabel").type, "invalid");
  assert.equal(parseHeaderCommand("   ").type, "status");
  assert.ok(describeConfig({ label: DEFAULT_LABEL }).includes("default label"));
  assert.ok(describeConfig({ label: "MY DECK" }).includes("MY DECK"));
});

test("/muelsyse-header sets, reports, rejects and resets the label", async () => {
  const { default: header } = await headerExtension();
  const { DEFAULT_LABEL, LABEL_CONFIG_PATH } = await label();
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  let command: { handler: (args: string, ctx: unknown) => void } | undefined;
  const notices: [string, string?][] = [];
  const pi = {
    on: (name: string, fn: (event: unknown, ctx: unknown) => unknown) => void handlers.set(name, fn),
    registerCommand: (name: string, options: typeof command) => void (name === "muelsyse-header" && (command = options)),
    getCommands: () => [],
  };
  let installed: (() => { render(width: number): string[] }) | undefined;
  const ui = {
    theme: { getColorMode: () => "truecolor" },
    notify: (message: string, type?: string) => notices.push([message, type]),
    setHeader: (factory?: unknown) => void (installed = factory as typeof installed),
  };
  header(pi as never);
  const ctx = { mode: "tui", hasUI: true, ui };
  await handlers.get("session_start")!({ type: "session_start" }, ctx);
  assert.ok(installed, "the header is installed on session start");
  const renderedLabel = () => strip(installed!().render(80).join("\n"));

  command!.handler('"MY DECK"', ctx);
  assert.deepEqual(notices.at(-1), ["Muelsyse label set to MY DECK.", "info"]);
  assert.equal(JSON.parse(readFileSync(LABEL_CONFIG_PATH, "utf8")).label, "MY DECK");
  assert.ok(renderedLabel().includes("MY DECK"), "the header repaints with the new label");

  command!.handler("status", ctx);
  assert.ok(notices.at(-1)![0].includes("MY DECK"), notices.at(-1)![0]);

  command!.handler("", ctx);
  assert.ok(notices.at(-1)![0].includes("MY DECK"), "an empty argument shows the status");

  command!.handler("bad\tlabel", ctx);
  assert.equal(notices.at(-1)![1], "warning");

  command!.handler("reset", ctx);
  assert.ok(notices.at(-1)![0].startsWith("Default Muelsyse label restored"), notices.at(-1)![0]);
  assert.equal(existsSync(LABEL_CONFIG_PATH), false, "reset drops the customization");
  assert.ok(renderedLabel().includes(DEFAULT_LABEL));
});
