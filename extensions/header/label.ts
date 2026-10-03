import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Label under the artwork; `/muelsyse-header "<text>"` replaces it. */
export const DEFAULT_LABEL = "◈  MUELSYSE CYBERDECK  ◈";
export const LABEL_CONFIG_PATH = join(getAgentDir(), "muelsyse-macaron-header.json");

// The label is rendered on a single line: control characters (including escapes and
// tabs) would break the frame, and tabs are rejected by the artwork reader for the
// same reason.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

export type HeaderConfig = { label: string };

const defaultConfig = (): HeaderConfig => ({ label: DEFAULT_LABEL });
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A renderable label, or undefined for anything the header must not receive. */
export function normalizeLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const label = value.trim();
  return !label || CONTROL_CHARS.test(label) ? undefined : label;
}

export function loadConfig(path = LABEL_CONFIG_PATH): { config: HeaderConfig; error?: string } {
  try {
    if (!existsSync(path)) return { config: defaultConfig() };
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    const raw = (parsed && typeof parsed === "object" ? parsed : {}) as { label?: unknown };
    if (raw.label === undefined) return { config: defaultConfig() };
    const label = normalizeLabel(raw.label);
    return label ? { config: { label } } : { config: defaultConfig(), error: `label in ${path} must be a single line of text` };
  } catch (error) {
    return { config: defaultConfig(), error: message(error) };
  }
}

/** Returns an error message instead of throwing. */
export function saveConfig(config: HeaderConfig, path = LABEL_CONFIG_PATH): string | undefined {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    renameSync(tmp, path);
    return undefined;
  } catch (error) {
    return message(error);
  }
}

/** Drops the customization; a missing file already means "default". */
export function clearConfig(path = LABEL_CONFIG_PATH): string | undefined {
  try {
    unlinkSync(path);
    return undefined;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : message(error);
  }
}

export type HeaderCommand =
  | { type: "status" }
  | { type: "help" }
  | { type: "reset" }
  | { type: "set"; label: string }
  | { type: "invalid"; message: string };

export const HELP_TEXT = [
  "/muelsyse-header                    show the current label",
  '/muelsyse-header "<text>"           use a custom label',
  "/muelsyse-header reset              restore the default label",
].join("\n");

export function parseHeaderCommand(args: string): HeaderCommand {
  const input = args.trim();
  const keyword = input.toLowerCase();
  if (!input || keyword === "status") return { type: "status" };
  if (keyword === "help") return { type: "help" };
  if (keyword === "reset") return { type: "reset" };
  const quoted = (input.startsWith('"') && input.endsWith('"')) || (input.startsWith("'") && input.endsWith("'"));
  const label = normalizeLabel(quoted ? input.slice(1, -1) : input);
  return label
    ? { type: "set", label }
    : { type: "invalid", message: "A label must be one line of text; tabs, escapes and line breaks are rejected." };
}

export function describeConfig(config: HeaderConfig, path = LABEL_CONFIG_PATH): string {
  return config.label === DEFAULT_LABEL
    ? `Muelsyse header: default label · ${path}`
    : `Muelsyse header: ${config.label} · ${path}`;
}
