import fs from "node:fs/promises";
import path from "node:path";

export const readTextFile = async (filePath: string): Promise<string> => {
  return fs.readFile(filePath, "utf8");
};

export const readJsonFile = async <T>(filePath: string): Promise<T> => {
  const text = await readTextFile(filePath);
  return JSON.parse(text) as T;
};

export const ensureParentDir = async (filePath: string): Promise<void> => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
};

export const writeTextFile = async (filePath: string, contents: string): Promise<void> => {
  await ensureParentDir(filePath);
  await fs.writeFile(filePath, contents, "utf8");
};

export const writeJsonFile = async (filePath: string, value: unknown): Promise<void> => {
  await writeTextFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
};

export const replaceExtension = (filePath: string, extension: string): string => {
  const parsed = path.parse(filePath);
  return path.join(parsed.dir, `${parsed.name}${extension}`);
};

export const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
};
