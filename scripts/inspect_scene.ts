import { parseArgs, requireFlag } from "./lib/cli.js";
import { readTextFile } from "./lib/io.js";
import { runBrowserOperation } from "./lib/browser_runtime.js";

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const scenePath = requireFlag(args, "scene");
  const sceneText = await readTextFile(scenePath);
  const result = await runBrowserOperation<{ report: Record<string, unknown> }>("inspectScene", {
    text: sceneText,
  });

  console.log(JSON.stringify(result.report, null, 2));
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
