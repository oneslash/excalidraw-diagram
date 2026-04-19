import { getBooleanFlag, getNumberFlag, parseArgs, requireFlag } from "./lib/cli.js";
import { toPortablePath } from "./lib/artifact_manifest.js";
import { readTextFile, writeTextFile } from "./lib/io.js";
import { runBrowserOperation } from "./lib/browser_runtime.js";

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const scenePath = requireFlag(args, "scene");
  const outputPath = requireFlag(args, "out");
  const artifactRoot = typeof args.flags["artifact-root"] === "string" ? String(args.flags["artifact-root"]) : undefined;
  const sceneText = await readTextFile(scenePath);

  const result = await runBrowserOperation<{ svgText: string; summary: Record<string, unknown> }>("exportSvg", {
    text: sceneText,
    options: {
      padding: getNumberFlag(args, "padding", 20),
      background: getBooleanFlag(args, "background", true),
      darkMode: getBooleanFlag(args, "dark-mode", false),
      embedScene: getBooleanFlag(args, "embed-scene", false),
    },
  });

  await writeTextFile(outputPath, result.svgText);
  console.log(JSON.stringify({
    outputPath: toPortablePath(outputPath, artifactRoot),
    summary: result.summary,
  }, null, 2));
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
