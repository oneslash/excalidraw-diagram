export type ParsedArgs = {
  flags: Record<string, string | boolean>;
  positionals: string[];
};

export const parseArgs = (argv: string[]): ParsedArgs => {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const withoutPrefix = token.slice(2);
    const [name, inlineValue] = withoutPrefix.split("=", 2);
    if (inlineValue !== undefined) {
      flags[name] = inlineValue;
      continue;
    }

    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      flags[name] = true;
      continue;
    }

    flags[name] = next;
    index += 1;
  }

  return { flags, positionals };
};

export const requireFlag = (args: ParsedArgs, name: string): string => {
  const value = args.flags[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing required flag --${name}`);
  }
  return value;
};

export const getOptionalFlag = (args: ParsedArgs, name: string): string | undefined => {
  const value = args.flags[name];
  return typeof value === "string" ? value : undefined;
};

export const getBooleanFlag = (args: ParsedArgs, name: string, defaultValue = false): boolean => {
  const value = args.flags[name];
  if (value === undefined) {
    return defaultValue;
  }
  if (typeof value === "boolean") {
    return value;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  throw new Error(`Flag --${name} must be a boolean value`);
};

export const getNumberFlag = (args: ParsedArgs, name: string, defaultValue: number): number => {
  const value = args.flags[name];
  if (value === undefined) {
    return defaultValue;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Flag --${name} must be a number`);
  }
  return parsed;
};
