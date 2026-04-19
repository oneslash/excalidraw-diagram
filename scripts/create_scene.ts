import { getBooleanFlag, getNumberFlag, getOptionalFlag, parseArgs, requireFlag } from "./lib/cli.js";
import { toPortablePath } from "./lib/artifact_manifest.js";
import { readJsonFile, writeTextFile } from "./lib/io.js";
import { runBrowserOperation } from "./lib/browser_runtime.js";
import type { SceneSpec } from "./lib/scene_spec.js";
import { assertVerificationPassed, verifySceneText, writeVerificationReport } from "./lib/verification.js";

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const specPath = requireFlag(args, "spec");
  const outputPath = requireFlag(args, "out");
  const artifactRoot = getOptionalFlag(args, "artifact-root");
  const spec = await readJsonFile<SceneSpec>(specPath);
  const result = await runBrowserOperation<{ sceneText: string; report: Record<string, unknown> }>("createScene", { spec });
  await writeTextFile(outputPath, result.sceneText);

  const response: Record<string, unknown> = {
    outputPath: toPortablePath(outputPath, artifactRoot),
    report: result.report,
  };

  if (getBooleanFlag(args, "verify", false)) {
    const verification = await verifySceneText(result.sceneText, outputPath, {
      svgPath: getOptionalFlag(args, "svg-out"),
      previewPath: getOptionalFlag(args, "preview-out"),
      maxWarnings: getNumberFlag(args, "max-warnings", Number(spec.document?.maxWarnings ?? 0)),
      minimumEditableElements: getNumberFlag(
        args,
        "minimum-editable-elements",
        Number(spec.document?.minimumEditableElements ?? 2),
      ),
      requireStructuredScene: true,
      metadata: {
        layoutEngine: result.report.layoutEngine,
        layoutEngineReason: result.report.layoutEngineReason,
        preset: result.report.preset,
      },
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
