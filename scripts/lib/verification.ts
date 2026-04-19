import { toPortablePath } from "./artifact_manifest.js";
import { captureSvgScreenshot, runBrowserOperation } from "./browser_runtime.js";
import { replaceExtension, writeJsonFile, writeTextFile } from "./io.js";

export type VerificationPolicy = {
  maxWarnings: number;
  minimumEditableElements: number;
  requireStructuredScene: boolean;
};

export type VerificationResult = {
  svgPath: string;
  previewPath: string;
  screenshot: {
    width: number;
    height: number;
  };
  exportSummary: Record<string, unknown>;
  inspectSummary: Record<string, unknown>;
  warnings: string[];
  hardFailures: string[];
  passed: boolean;
  metadata?: Record<string, unknown>;
  policy: VerificationPolicy;
  manualChecklist: string[];
};

const asFiniteNumber = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const collectHardFailures = (
  inspectSummary: Record<string, unknown>,
  exportSummary: Record<string, unknown>,
  screenshot: { width: number; height: number },
  policy: VerificationPolicy,
): string[] => {
  const hardFailures: string[] = [];
  const nonDeletedElements = asFiniteNumber(inspectSummary.nonDeletedElements) ?? 0;
  const editableGeometryCount = asFiniteNumber(inspectSummary.editableGeometryCount) ?? 0;
  const imageElementCount = asFiniteNumber(inspectSummary.imageElementCount) ?? 0;
  const exportWidth = asFiniteNumber(exportSummary.width) ?? 0;
  const exportHeight = asFiniteNumber(exportSummary.height) ?? 0;
  const bounds = inspectSummary.bounds as Record<string, unknown> | null | undefined;
  const boundsWidth = bounds ? (asFiniteNumber(bounds.maxX) ?? 0) - (asFiniteNumber(bounds.minX) ?? 0) : 0;
  const boundsHeight = bounds ? (asFiniteNumber(bounds.maxY) ?? 0) - (asFiniteNumber(bounds.minY) ?? 0) : 0;
  const qualityFindings = Array.isArray(inspectSummary.qualityFindings)
    ? inspectSummary.qualityFindings as Array<Record<string, unknown>>
    : [];
  const bindingIssues = Array.isArray(inspectSummary.bindingIssues)
    ? inspectSummary.bindingIssues.filter((issue): issue is string => typeof issue === "string")
    : [];
  const frameIssues = Array.isArray(inspectSummary.frameIssues)
    ? inspectSummary.frameIssues.filter((issue): issue is string => typeof issue === "string")
    : [];
  const missingFileIds = Array.isArray(inspectSummary.missingFileIds)
    ? inspectSummary.missingFileIds.filter((issue): issue is string => typeof issue === "string")
    : [];

  if (nonDeletedElements <= 0) {
    hardFailures.push("scene contains no non-deleted elements");
  }
  if (screenshot.width < 80 || screenshot.height < 80) {
    hardFailures.push(`preview screenshot is too small (${screenshot.width}x${screenshot.height})`);
  }
  if (exportWidth < 80 || exportHeight < 80) {
    hardFailures.push(`exported SVG is too small (${exportWidth}x${exportHeight})`);
  }
  if (boundsWidth <= 40 || boundsHeight <= 40) {
    hardFailures.push(`scene bounds are suspiciously small (${Math.round(boundsWidth)}x${Math.round(boundsHeight)})`);
  }
  if (imageElementCount > 0 && editableGeometryCount === 0) {
    hardFailures.push("scene is image-only and does not contain editable geometry");
  }
  if (policy.requireStructuredScene && editableGeometryCount < policy.minimumEditableElements) {
    hardFailures.push(
      `scene contains only ${editableGeometryCount} editable geometry element(s); expected at least ${policy.minimumEditableElements}`,
    );
  }
  for (const issue of bindingIssues) {
    hardFailures.push(`binding issue: ${issue}`);
  }
  for (const issue of frameIssues) {
    hardFailures.push(`frame issue: ${issue}`);
  }
  for (const fileId of missingFileIds) {
    hardFailures.push(`missing file asset: ${fileId}`);
  }

  for (const finding of qualityFindings) {
    if (String(finding.severity ?? "") !== "error") {
      continue;
    }
    const message = String(finding.message ?? "").trim();
    if (message.length > 0) {
      hardFailures.push(message);
    }
  }

  return [...new Set(hardFailures)];
};

export const verifySceneText = async (
  sceneText: string,
  outputScenePath: string,
  options?: {
    svgPath?: string;
    previewPath?: string;
    backgroundColor?: string;
    padding?: number;
    darkMode?: boolean;
    embedScene?: boolean;
    additionalWarnings?: string[];
    metadata?: Record<string, unknown>;
    maxWarnings?: number;
    minimumEditableElements?: number;
    requireStructuredScene?: boolean;
    artifactRoot?: string;
  },
): Promise<VerificationResult> => {
  const svgPath = options?.svgPath ?? replaceExtension(outputScenePath, ".svg");
  const previewPath = options?.previewPath ?? replaceExtension(outputScenePath, ".preview.png");
  const exportResult = await runBrowserOperation<{
    svgText: string;
    summary: Record<string, unknown>;
  }>("exportSvg", {
    text: sceneText,
    options: {
      padding: options?.padding,
      darkMode: options?.darkMode,
      embedScene: options?.embedScene,
    },
  });

  await writeTextFile(svgPath, exportResult.svgText);
  const screenshot = await captureSvgScreenshot(exportResult.svgText, previewPath, {
    backgroundColor: options?.backgroundColor,
  });
  const inspectResult = await runBrowserOperation<{ report: Record<string, unknown> }>("inspectScene", { text: sceneText });
  const inspectWarnings = Array.isArray(inspectResult.report.qualityWarnings)
    ? inspectResult.report.qualityWarnings.filter((warning): warning is string => typeof warning === "string")
    : [];
  const warnings = [...new Set([...(options?.additionalWarnings ?? []), ...inspectWarnings])];
  const policy: VerificationPolicy = {
    maxWarnings: Number.isFinite(options?.maxWarnings as number) ? Number(options?.maxWarnings) : 0,
    minimumEditableElements: Number.isFinite(options?.minimumEditableElements as number)
      ? Number(options?.minimumEditableElements)
      : 2,
    requireStructuredScene: options?.requireStructuredScene !== false,
  };
  const hardFailures = collectHardFailures(inspectResult.report, exportResult.summary, screenshot, policy);
  const passed = hardFailures.length === 0 && warnings.length <= policy.maxWarnings;

  return {
    svgPath: toPortablePath(svgPath, options?.artifactRoot),
    previewPath: toPortablePath(previewPath, options?.artifactRoot),
    screenshot,
    exportSummary: exportResult.summary,
    inspectSummary: inspectResult.report,
    warnings,
    hardFailures,
    passed,
    metadata: options?.metadata,
    policy,
    manualChecklist: [
      "Open the preview PNG and confirm labels are readable without overlap.",
      "Confirm arrows connect the intended shapes and do not float in empty space.",
      "Confirm the diagram fits the canvas without major clipping.",
      "Confirm frames, if present, wrap the intended nodes.",
    ],
  };
};

export const assertVerificationPassed = (result: VerificationResult): void => {
  if (result.hardFailures.length > 0) {
    throw new Error(
      `Verification failed hard checks:\n- ${result.hardFailures.join("\n- ")}`,
    );
  }
  if (result.warnings.length > result.policy.maxWarnings) {
    throw new Error(
      `Verification exceeded the warning budget (${result.warnings.length} > ${result.policy.maxWarnings}):\n- ${result.warnings.join("\n- ")}`,
    );
  }
};

export const writeVerificationReport = async (
  outputScenePath: string,
  result: VerificationResult,
  artifactRoot?: string,
): Promise<string> => {
  const reportPath = replaceExtension(outputScenePath, ".verification.json");
  await writeJsonFile(reportPath, result);
  return toPortablePath(reportPath, artifactRoot);
};
