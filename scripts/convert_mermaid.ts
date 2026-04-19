import { getBooleanFlag, getNumberFlag, getOptionalFlag, parseArgs, requireFlag } from "./lib/cli.js";
import { toPortablePath } from "./lib/artifact_manifest.js";
import { readTextFile, writeTextFile } from "./lib/io.js";
import { runBrowserOperation } from "./lib/browser_runtime.js";
import { assertVerificationPassed, verifySceneText, writeVerificationReport } from "./lib/verification.js";

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = requireFlag(args, "input");
  const outputPath = requireFlag(args, "out");
  const artifactRoot = getOptionalFlag(args, "artifact-root");
  if ("strict-flowchart" in args.flags && !getBooleanFlag(args, "strict-flowchart", true)) {
    throw new Error(
      "Best-effort Mermaid fallback has been removed. Mermaid conversion is flowchart-only now. Rewrite the input as a Mermaid flowchart or use create_scene.ts with a SceneSpec.",
    );
  }
  const mermaidText = await readTextFile(inputPath);

  const result = await runBrowserOperation<{ sceneText: string; report: Record<string, unknown> }>("convertMermaid", {
    text: mermaidText,
  });

  await writeTextFile(outputPath, result.sceneText);
  const response: Record<string, unknown> = {
    outputPath: toPortablePath(outputPath, artifactRoot),
    report: result.report,
    warnings: Array.isArray(result.report.warnings) ? result.report.warnings : [],
  };

  if (getBooleanFlag(args, "verify", false)) {
    const verification = await verifySceneText(result.sceneText, outputPath, {
      svgPath: getOptionalFlag(args, "svg-out"),
      previewPath: getOptionalFlag(args, "preview-out"),
      additionalWarnings: Array.isArray(result.report.warnings)
        ? (result.report.warnings as string[])
        : [],
      metadata: {
        status: result.report.status,
        treatedAsFlowchart: result.report.treatedAsFlowchart,
        fellBackToImage: result.report.fellBackToImage,
        flowchartOnly: result.report.flowchartOnly,
      },
      maxWarnings: getNumberFlag(args, "max-warnings", 0),
      minimumEditableElements: getNumberFlag(args, "minimum-editable-elements", 3),
      requireStructuredScene: true,
      artifactRoot,
    });
    const reportPath = await writeVerificationReport(outputPath, verification, artifactRoot);
    response.verification = {
      ...verification,
      reportPath,
    };
    response.warnings = verification.warnings;
    assertVerificationPassed(verification);
  }

  console.log(JSON.stringify(response, null, 2));
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
