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
  const inputText = await readTextFile(inputPath);

  const result = await runBrowserOperation<{
    kind: string;
    outputText: string;
    report: Record<string, unknown>;
  }>("repairScene", {
    text: inputText,
    refreshTextDimensions: getBooleanFlag(args, "refresh-text-dimensions", false),
  });

  await writeTextFile(outputPath, result.outputText);
  const response: Record<string, unknown> = {
    outputPath: toPortablePath(outputPath, artifactRoot),
    kind: result.kind,
    report: result.report,
  };

  if (result.kind !== "library" && getBooleanFlag(args, "verify", false)) {
    const verification = await verifySceneText(result.outputText, outputPath, {
      svgPath: getOptionalFlag(args, "svg-out"),
      previewPath: getOptionalFlag(args, "preview-out"),
      metadata: {
        inputKind: result.kind,
      },
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
