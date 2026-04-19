import { getNumberFlag, getOptionalFlag, parseArgs, requireFlag } from "./lib/cli.js";
import { toPortablePath } from "./lib/artifact_manifest.js";
import { readTextFile } from "./lib/io.js";
import { assertVerificationPassed, verifySceneText, writeVerificationReport } from "./lib/verification.js";

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const scenePath = requireFlag(args, "scene");
  const artifactRoot = getOptionalFlag(args, "artifact-root");
  const sceneText = await readTextFile(scenePath);
  const result = await verifySceneText(sceneText, scenePath, {
    svgPath: getOptionalFlag(args, "svg-out"),
    previewPath: getOptionalFlag(args, "preview-out"),
    maxWarnings: getNumberFlag(args, "max-warnings", 0),
    minimumEditableElements: getNumberFlag(args, "minimum-editable-elements", 2),
    requireStructuredScene: true,
    artifactRoot,
  });
  const reportPath = await writeVerificationReport(scenePath, result, artifactRoot);
  assertVerificationPassed(result);

  console.log(JSON.stringify({
    scenePath: toPortablePath(scenePath, artifactRoot),
    ...result,
    reportPath,
  }, null, 2));
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
