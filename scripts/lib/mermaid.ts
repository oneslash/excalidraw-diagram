import { convertToExcalidrawElements } from "@excalidraw/excalidraw";
import { parseMermaidToExcalidraw } from "@excalidraw/mermaid-to-excalidraw";

import { buildAppState, type GenericRecord } from "./scene_spec.js";
import { serializeScene } from "./normalize.js";
import { autoRepairElements } from "./scene_ops.js";

const detectMermaidKind = (text: string): string => {
  const trimmed = text.trim();
  const match = trimmed.match(/^(?:%%\{.*?\}%%\s*)?([a-zA-Z]+)/m);
  return match?.[1]?.toLowerCase() ?? "unknown";
};

export const convertMermaidScene = async (
  text: string,
  options?: { config?: GenericRecord },
): Promise<{ sceneText: string; report: GenericRecord }> => {
  const detectedKind = detectMermaidKind(text);
  const startsLikeFlowchart = /^(?:%%\{.*?\}%%\s*)?(?:flowchart|graph)\b/m.test(text.trim());
  if (!startsLikeFlowchart) {
    throw new Error(
      `Mermaid conversion is flowchart-only. This input looks like "${detectedKind}", not a Mermaid flowchart. Rewrite it as a Mermaid flowchart or use create_scene.ts with a SceneSpec.`,
    );
  }

  const result = await parseMermaidToExcalidraw(text, options?.config);
  const rawElements = convertToExcalidrawElements(result.elements as any, { regenerateIds: false }) as GenericRecord[];
  const repaired = autoRepairElements(rawElements, result.files ?? {}, "scene", {
    preset: "clean-flowchart",
  });
  const report = repaired.report;
  const fellBackToImage = Number(report.imageElementCount ?? 0) >= 1 && Number(report.editableGeometryCount ?? 0) === 0;
  if (fellBackToImage) {
    throw new Error(
      "Mermaid flowchart conversion fell back to an embedded image instead of editable Excalidraw geometry. Rewrite it as a simpler Mermaid flowchart or use create_scene.ts with a SceneSpec.",
    );
  }
  if (Number(report.editableGeometryCount ?? 0) < 3) {
    throw new Error(
      `Mermaid flowchart conversion produced only ${report.editableGeometryCount ?? 0} editable geometry element(s). Rewrite it as a simpler Mermaid flowchart or use create_scene.ts with a SceneSpec.`,
    );
  }

  const appState = buildAppState({
    preset: "clean-flowchart",
  });

  return {
    sceneText: serializeScene(repaired.elements, appState, result.files ?? {}),
    report: {
      status: "passed",
      flowchartOnly: true,
      treatedAsFlowchart: true,
      detectedKind,
      filesCount: Object.keys(result.files ?? {}).length,
      fellBackToImage: false,
      editableGeometryCount: report.editableGeometryCount,
      shapeElementCount: report.shapeElementCount,
      linearElementCount: report.linearElementCount,
      autoFixes: repaired.autoFixes,
      qualityWarnings: report.qualityWarnings ?? [],
      warnings: [],
    },
  };
};
