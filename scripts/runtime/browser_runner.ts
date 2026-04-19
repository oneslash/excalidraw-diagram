import { exportToSvg } from "@excalidraw/excalidraw";

import { convertMermaidScene } from "../lib/mermaid.js";
import { parseSceneLikeText } from "../lib/normalize.js";
import { applyPatchOperations, createSceneFromSpec, inspectSceneText, repairSceneText } from "../lib/scene_ops.js";
import type { GenericRecord, PatchSpec, SceneSpec } from "../lib/scene_spec.js";

const browserRunner = {
  async createScene(payload: GenericRecord) {
    const spec = (payload.spec ?? payload) as SceneSpec;
    return createSceneFromSpec(spec);
  },

  editScene(payload: GenericRecord) {
    return applyPatchOperations(String(payload.text ?? ""), payload.patch as PatchSpec);
  },

  repairScene(payload: GenericRecord) {
    return repairSceneText(String(payload.text ?? ""), Boolean(payload.refreshTextDimensions));
  },

  inspectScene(payload: GenericRecord) {
    return inspectSceneText(String(payload.text ?? ""));
  },

  async convertMermaid(payload: GenericRecord) {
    return convertMermaidScene(String(payload.text ?? ""), {
      config: payload.config,
    });
  },

  async exportSvg(payload: GenericRecord) {
    const restored = parseSceneLikeText(String(payload.text ?? ""));
    const options = payload.options ?? {};
    const appState = {
      ...restored.appState,
      exportBackground: options.background ?? restored.appState.exportBackground ?? true,
      exportWithDarkMode: options.darkMode ?? restored.appState.exportWithDarkMode ?? false,
      exportEmbedScene: options.embedScene ?? false,
    };
    const svg = await exportToSvg({
      elements: restored.elements.filter((element) => !element.isDeleted) as any,
      appState: appState as any,
      files: restored.files as any,
      exportPadding: Number(options.padding ?? 20),
    });
    return {
      svgText: svg.outerHTML,
      summary: {
        width: svg.viewBox.baseVal.width,
        height: svg.viewBox.baseVal.height,
        exportPadding: Number(options.padding ?? 20),
      },
    };
  },
};

declare global {
  interface Window {
    __excalidrawRunner: typeof browserRunner;
  }
}

window.__excalidrawRunner = browserRunner;
