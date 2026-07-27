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

const toolbarTimers = new Map<string, ReturnType<typeof setTimeout>>();
const toolbarElements = new Set<HTMLElement>();
let toolbarEnabled = true;
let toolbarVisible = true;
let toolbarGeneration = 0;
let renderSequence = 0;
let requestSequence = 0;

export function activateRunAllToolbar(): void {
  toolbarEnabled = true;
  toolbarGeneration += 1;
}

export function clearRunAllToolbarTimers(): void {
  for (const timer of toolbarTimers.values()) clearTimeout(timer);
  toolbarTimers.clear();
}

export function disposeRunAllToolbar(): void {
  toolbarEnabled = false;
  toolbarGeneration += 1;
  clearRunAllToolbarTimers();
  for (const toolbar of toolbarElements) toolbar.remove();
  toolbarElements.clear();
}

function removeToolbar(toolbar: HTMLElement | null): void {
  if (!toolbar) return;
  toolbarElements.delete(toolbar);
  toolbar.remove();
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
  for (const toolbar of toolbarElements) {
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

export async function setRunAllToolbarVisible(
  visible: boolean,
  context: RunAllToolbarContext,
): Promise<void> {
  toolbarVisible = visible;
  clearRunAllToolbarTimers();
  if (!visible) {
    for (const toolbar of toolbarElements) toolbar.remove();
    toolbarElements.clear();
    return;
  }

  const sourcePaths = new Set<string>();
  for (const leaf of context.app.workspace?.getLeavesOfType?.("markdown") ?? []) {
    const view = leaf.view as unknown as MarkdownViewLike;
    if (typeof view.file?.path === "string") sourcePaths.add(view.file.path);
  }
  const generation = toolbarGeneration;
  await Promise.all(
    [...sourcePaths].flatMap((sourcePath) =>
      findToolbarHostsInWorkspace(context.app, sourcePath).map((host) =>
        renderToolbarInHost(host, sourcePath, context, generation)
      )
    )
  );
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
  generation: number,
): Promise<HTMLElement | null> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (!toolbarEnabled || !toolbarVisible || generation !== toolbarGeneration) return null;
    const directHost = el.closest<HTMLElement>(".markdown-preview-view")
      ?? el.closest<HTMLElement>(".markdown-preview-sizer");
    const workspaceHost = findToolbarHostsInWorkspace(app, sourcePath)[0];
    const host = directHost ?? workspaceHost;
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

async function renderToolbarInHost(
  host: HTMLElement,
  sourcePath: string,
  context: RunAllToolbarContext,
  generation: number,
): Promise<void> {
  if (!toolbarEnabled || !toolbarVisible || generation !== toolbarGeneration) return;
  const requestVersion = String(++requestSequence);
  host.dataset.nbRunAllToolbarRequestedSource = sourcePath;
  host.dataset.nbRunAllToolbarRequestVersion = requestVersion;
  const pendingToken = host.dataset.nbRunAllToolbarPending;
  if (pendingToken && !pendingToken.startsWith(`${generation}:`)) {
    delete host.dataset.nbRunAllToolbarPending;
  }
  if (host.dataset.nbRunAllToolbarPending) return;

  const renderToken = `${generation}:${++renderSequence}`;
  host.dataset.nbRunAllToolbarPending = renderToken;
  let toolbar = host.querySelector<HTMLElement>(".nb-run-all-toolbar");
  if (toolbar && toolbar.dataset.sourcePath !== sourcePath) {
    removeToolbar(toolbar);
    toolbar = null;
  }

  try {
    const file = context.app.vault.getAbstractFileByPath(sourcePath);
    if (!isMarkdownFile(file)) return;

    if (!toolbar) {
      toolbar = host.createDiv({ cls: "nb-run-all-toolbar" });
      toolbarElements.add(toolbar);
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
        const currentFile = context.app.vault.getAbstractFileByPath(sourcePath);
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
    if (
      !toolbarEnabled
      || generation !== toolbarGeneration
      || host.dataset.nbRunAllToolbarRequestedSource !== sourcePath
      || host.dataset.nbRunAllToolbarRequestVersion !== requestVersion
    ) return;

    const blocks = parseRunBlocks(content);
    if (blocks.length === 0) {
      removeToolbar(toolbar);
      return;
    }

    const currentState = getRunAllProgress(file.path);
    updateToolbar(
      toolbar,
      currentState ?? { running: false, current: blocks.length, total: blocks.length },
    );
  } catch (err) {
    if (toolbar?.dataset.cellCount === "0") removeToolbar(toolbar);
    console.error("[MarkdownNotebook] Failed to render Run all toolbar:", err);
  } finally {
    if (host.dataset.nbRunAllToolbarPending === renderToken) {
      delete host.dataset.nbRunAllToolbarPending;
      if (toolbarEnabled && generation === toolbarGeneration) {
        const requestedSource = host.dataset.nbRunAllToolbarRequestedSource;
        const latestRequestVersion = host.dataset.nbRunAllToolbarRequestVersion;
        if (
          requestedSource
          && (requestedSource !== sourcePath || latestRequestVersion !== requestVersion)
        ) {
          void renderToolbarInHost(host, requestedSource, context, generation);
        } else {
          delete host.dataset.nbRunAllToolbarRequestedSource;
          delete host.dataset.nbRunAllToolbarRequestVersion;
        }
      }
    }
  }
}

export async function renderRunAllToolbar(
  el: HTMLElement,
  ctx: MarkdownPostProcessorContext,
  context: RunAllToolbarContext,
): Promise<void> {
  const generation = toolbarGeneration;
  if (!toolbarEnabled || !toolbarVisible) return;
  const host = await findToolbarHost(el, ctx.sourcePath, context.app, generation);
  if (!host) return;
  await renderToolbarInHost(host, ctx.sourcePath, context, generation);
}

export function scheduleRunAllToolbarRender(
  ctx: MarkdownPostProcessorContext,
  context: RunAllToolbarContext,
  delay = 200,
): void {
  if (!toolbarEnabled || !toolbarVisible) return;
  const sourcePath = ctx.sourcePath;
  const generation = toolbarGeneration;
  const existing = toolbarTimers.get(sourcePath);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    toolbarTimers.delete(sourcePath);
    if (!toolbarEnabled || !toolbarVisible || generation !== toolbarGeneration) return;
    for (const host of findToolbarHostsInWorkspace(context.app, sourcePath)) {
      void renderToolbarInHost(host, sourcePath, context, generation);
    }
  }, delay);
  toolbarTimers.set(sourcePath, timer);
}
