import { App, MarkdownPostProcessorContext, Notice, TFile } from "obsidian";
import { parseRunBlocks } from "./CellParser";
import {
  getRunAllProgress,
  runAll,
  RunAllHooks,
  RunAllProgress,
} from "./RunAll";
import type { BaseKernel } from "./kernels/BaseKernel";
import type { ShellKernel } from "./kernels/ShellKernel";
import type { PluginSettings } from "./settings/Settings";

type AnyKernel = BaseKernel | ShellKernel;

export interface RunAllToolbarContext {
  app: App;
  getKernel: (language: string) => AnyKernel;
  getSettings: () => PluginSettings;
}

function cellCountLabel(total: number): string {
  return `${total} cell${total === 1 ? "" : "s"}`;
}

function updateToolbar(toolbar: HTMLElement, state: RunAllProgress): void {
  const button = toolbar.querySelector<HTMLButtonElement>(".nb-run-all-button");
  const status = toolbar.querySelector<HTMLElement>(".nb-run-all-status");
  if (!button || !status) return;

  const total = state.total ?? Number(toolbar.dataset.cellCount ?? 0);
  toolbar.dataset.cellCount = String(total);
  if (state.running) {
    button.disabled = true;
    button.textContent = "● Running";
    status.textContent = `Running ${state.current} / ${total}`;
  } else {
    button.disabled = false;
    button.textContent = "▶ Run all cells";
    status.textContent = cellCountLabel(total);
  }
}

export function setRunAllToolbarState(sourcePath: string, state: RunAllProgress): void {
  if (typeof document === "undefined") return;
  const toolbars = document.querySelectorAll<HTMLElement>(".nb-run-all-toolbar");
  for (const toolbar of Array.from(toolbars)) {
    if (toolbar.dataset.sourcePath === sourcePath) updateToolbar(toolbar, state);
  }
}

export function runAllToolbarHooks(sourcePath: string): RunAllHooks {
  return {
    onStart: ({ total }) =>
      setRunAllToolbarState(sourcePath, { running: true, current: 0, total }),
    onProgress: ({ current, total }) =>
      setRunAllToolbarState(sourcePath, { running: true, current, total }),
    onComplete: ({ total }) =>
      setRunAllToolbarState(sourcePath, { running: false, current: total, total }),
  };
}

interface MarkdownViewLike {
  file?: { path?: string };
  contentEl?: HTMLElement;
  containerEl?: HTMLElement;
}

function findToolbarHostsInWorkspace(app: App, sourcePath: string): HTMLElement[] {
  const leaves = app.workspace?.getLeavesOfType?.("markdown") ?? [];
  const hosts = new Set<HTMLElement>();

  for (const leaf of leaves) {
    const view = leaf.view as unknown as MarkdownViewLike;
    if (view.file?.path !== sourcePath) continue;

    for (const root of [view.contentEl, view.containerEl]) {
      if (!root) continue;
      const previewView = root.matches(".markdown-preview-view")
        ? root
        : root.querySelector<HTMLElement>(".markdown-preview-view");
      if (previewView) {
        hosts.add(previewView);
        continue;
      }

      const previewSizer = root.querySelector<HTMLElement>(".markdown-preview-sizer");
      if (previewSizer) hosts.add(previewSizer);
    }
  }

  return [...hosts];
}

function waitForRenderTurn(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => resolve());
    } else {
      setTimeout(resolve, 0);
    }
  });
}

async function findToolbarHost(
  el: HTMLElement,
  sourcePath: string,
  app: App,
): Promise<HTMLElement | null> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const workspaceHost = findToolbarHostsInWorkspace(app, sourcePath)[0];
    const directHost = el.closest<HTMLElement>(".markdown-preview-sizer");
    const host = workspaceHost ?? directHost;
    if (host) return host;
    await waitForRenderTurn();
  }
  return null;
}

function isMarkdownFile(file: unknown): file is TFile {
  if (!file || typeof file !== "object") return false;
  const candidate = file as { path?: unknown; extension?: unknown };
  return typeof candidate.path === "string" && candidate.extension === "md";
}

export async function renderRunAllToolbar(
  el: HTMLElement,
  ctx: MarkdownPostProcessorContext,
  context: RunAllToolbarContext,
): Promise<void> {
  const host = await findToolbarHost(el, ctx.sourcePath, context.app);
  if (!host) return;
  let toolbar = host.querySelector<HTMLElement>(".nb-run-all-toolbar");
  if (toolbar && toolbar.dataset.sourcePath !== ctx.sourcePath) {
    toolbar.remove();
    toolbar = null;
  }
  if (host.dataset.nbRunAllToolbarPending === "true") return;
  host.dataset.nbRunAllToolbarPending = "true";

  try {
    const file = context.app.vault.getAbstractFileByPath(ctx.sourcePath);
    if (!isMarkdownFile(file)) return;

    if (!toolbar) {
      toolbar = host.createDiv({ cls: "nb-run-all-toolbar" });
      toolbar.dataset.sourcePath = file.path;
      toolbar.dataset.cellCount = "0";
      const button = toolbar.createEl("button", {
        cls: "nb-run-all-button",
        text: "▶ Run all cells",
      });
      toolbar.createEl("span", {
        cls: "nb-run-all-status",
        text: "Loading cells…",
      });
      host.prepend(toolbar);

      button.addEventListener("click", async () => {
        const currentFile = context.app.vault.getAbstractFileByPath(ctx.sourcePath);
        if (!isMarkdownFile(currentFile)) {
          new Notice("No active Markdown file.");
          return;
        }
        await runAll(
          context.app,
          currentFile,
          (language) => context.getKernel(language),
          context.getSettings(),
          runAllToolbarHooks(currentFile.path),
        );
      });
    }

    const content = await context.app.vault.read(file);
    const blocks = parseRunBlocks(content);
    if (blocks.length === 0) {
      toolbar.remove();
      return;
    }

    const currentState = getRunAllProgress(file.path);
    updateToolbar(
      toolbar,
      currentState ?? { running: false, current: blocks.length, total: blocks.length },
    );
  } catch (err) {
    if (toolbar?.dataset.cellCount === "0") toolbar.remove();
    console.error("[MarkdownNotebook] Failed to render Run all toolbar:", err);
  } finally {
    delete host.dataset.nbRunAllToolbarPending;
  }
}

const toolbarTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function scheduleRunAllToolbarRender(
  ctx: MarkdownPostProcessorContext,
  context: RunAllToolbarContext,
  delay = 200,
): void {
  const sourcePath = ctx.sourcePath;
  const existing = toolbarTimers.get(sourcePath);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    toolbarTimers.delete(sourcePath);
    for (const host of findToolbarHostsInWorkspace(context.app, sourcePath)) {
      void renderRunAllToolbar(host, ctx, context);
    }
  }, delay);
  toolbarTimers.set(sourcePath, timer);
}

export function clearRunAllToolbarTimers(): void {
  for (const timer of toolbarTimers.values()) clearTimeout(timer);
  toolbarTimers.clear();
}
