import { toPng } from "html-to-image";

/**
 * Render an HTML string to a base64-encoded PNG.
 * Uses html-to-image (SVG foreignObject) so the browser handles CSS rendering,
 * including Obsidian's CSS variables and theme styles.
 * Returns null if rendering fails or the input is empty.
 */
export async function renderHtmlToPng(html: string): Promise<string | null> {
  if (!html.trim()) return null;

  // The wrapper is off-screen; the container itself has no position so
  // html-to-image doesn't carry the offset into the SVG foreignObject clone.
  const wrapper = document.createElement("div");
  wrapper.style.cssText = "position:fixed;left:-9999px;top:0;";

  const container = document.createElement("div");
  container.style.cssText = "background:#ffffff;padding:12px;min-width:600px;";
  container.innerHTML = html;

  wrapper.appendChild(container);
  document.body.appendChild(wrapper);

  try {
    const dataUrl = await toPng(container, {
      backgroundColor: "#ffffff",
      pixelRatio: 2,
    });
    return dataUrl.split(",")[1] ?? null;
  } catch (e) {
    console.warn("[HtmlToImage] error:", e);
    return null;
  } finally {
    document.body.removeChild(wrapper);
  }
}
