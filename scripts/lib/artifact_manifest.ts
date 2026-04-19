import path from "node:path";

export type ArtifactStatus = "passed" | "passed_degraded" | "failed";

export type FixtureArtifactRecord = {
  fixtureId: string;
  fileBase: string;
  title: string;
  status: ArtifactStatus;
  expectedFail: boolean;
  command: string[];
  returnCode: number;
  warnings: string[];
  hardFailures: string[];
  failure?: string;
  outputPath?: string;
  scenePath?: string;
  svgPath?: string;
  previewPath?: string;
  verificationPath?: string;
  metrics?: Record<string, number | string | boolean | null>;
  metadata?: Record<string, unknown>;
};

const normalizeSeparators = (value: string): string => value.split(path.sep).join("/");

export const toPortablePath = (filePath: string, artifactRoot?: string): string => {
  if (!artifactRoot) {
    return normalizeSeparators(filePath);
  }

  const relative = path.relative(path.resolve(artifactRoot), path.resolve(filePath));
  if (!relative || relative.startsWith("..")) {
    return normalizeSeparators(filePath);
  }
  return normalizeSeparators(relative);
};
