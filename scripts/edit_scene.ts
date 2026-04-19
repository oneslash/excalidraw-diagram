import { getBooleanFlag, getNumberFlag, getOptionalFlag, parseArgs, requireFlag } from "./lib/cli.js";
import { toPortablePath } from "./lib/artifact_manifest.js";
import { readJsonFile, readTextFile, writeTextFile } from "./lib/io.js";
import { runBrowserOperation } from "./lib/browser_runtime.js";
import type { PatchSpec } from "./lib/scene_spec.js";
import { assertVerificationPassed, verifySceneText, writeVerificationReport } from "./lib/verification.js";

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const scenePath = requireFlag(args, "scene");
  const patchPath = requireFlag(args, "patch");
  const outputPath = requireFlag(args, "out");
  const artifactRoot = getOptionalFlag(args, "artifact-root");

  const [sceneText, patch] = await Promise.all([
    readTextFile(scenePath),
    readJsonFile<PatchSpec>(patchPath),
  ]);

  const result = await runBrowserOperation<{ sceneText: string; report: Record<string, unknown> }>("editScene", {
    text: sceneText,
    patch,
  });

  await writeTextFile(outputPath, result.sceneText);
  const response: Record<string, unknown> = {
    outputPath: toPortablePath(outputPath, artifactRoot),
    report: result.report,
  };

  if (getBooleanFlag(args, "verify", false)) {
    const verification = await verifySceneText(result.sceneText, outputPath, {
      svgPath: getOptionalFlag(args, "svg-out"),
      previewPath: getOptionalFlag(args, "preview-out"),
      maxWarnings: getNumberFlag(args, "max-warnings", 0),
      minimumEditableElements: getNumberFlag(args, "minimum-editable-elements", 2),
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
