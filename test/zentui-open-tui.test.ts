import assert from "node:assert/strict";
import { test } from "node:test";
import type { Component } from "@earendil-works/pi-tui";
import { installOpenTuiGradient } from "../extensions/zentui/open-tui";

/** 与 pi-open-tui 的 OpenTuiEditor 同名同形状：宿主的 isWorkingStatusEditor() 只认这个声明。 */
class OpenTuiEditor implements Component {
  embedWorkingStatus = true;
  render(): string[] {
    return [];
  }
  invalidate(): void {}
}

class CockpitEditor implements Component {
  render(): string[] {
    return [];
  }
  invalidate(): void {}
}

type Factory = (tui: unknown, theme: unknown, keybindings: unknown) => Component;

/** Minimal host stand-in: setEditorComponent() invokes the factory immediately, like Pi does. */
function makeCtx() {
  const theme = Object.assign(Object.create(null), { fg: (_color: string, text: string) => text });
  const created: Component[] = [];
  let factory: Factory | undefined;
  const ctx = {
    ui: {
      setEditorComponent(next?: Factory) {
        factory = next;
        if (!next) return;
        created.push(next({ requestRender: () => {}, children: [] }, theme, {}));
      },
      getEditorComponent: () => factory,
    },
  };
  return { ctx, created, currentFactory: () => factory };
}

test("open-tui editors give the working line back to the host status row", () => {
  const { ctx, created } = makeCtx();
  const originalSetter = ctx.ui.setEditorComponent;
  const openTuiFactory: Factory = () => new OpenTuiEditor();
  ctx.ui.setEditorComponent(openTuiFactory);

  const cleanup = installOpenTuiGradient(ctx as never, () => {});

  // 安装时就交还（本包晚于 Open TUI 加载的顺序），并且此后新建的实例同样处理。
  assert.equal(created.length, 2, "installing re-creates the live editor through the wrapper");
  assert.equal((created[0] as OpenTuiEditor).embedWorkingStatus, true, "the instance created before the wrap keeps its own flag");
  assert.equal((created[1] as OpenTuiEditor).embedWorkingStatus, false, "the live instance hands the working line back");
  ctx.ui.setEditorComponent(openTuiFactory);
  assert.equal((created.at(-1) as OpenTuiEditor).embedWorkingStatus, false, "later instances are handled too");

  cleanup();
  assert.equal(ctx.ui.setEditorComponent, originalSetter, "cleanup restores the original setter");
});

test("other editors are left untouched", () => {
  const { ctx, created } = makeCtx();
  const editor = new CockpitEditor();
  const cleanup = installOpenTuiGradient(ctx as never, () => {});
  ctx.ui.setEditorComponent(() => editor);
  assert.equal(created.at(-1), editor);
  assert.equal("embedWorkingStatus" in editor, false);
  cleanup();
});
