import {
  restoreAppState,
  restoreElements,
  restoreLibraryItems,
  serializeAsJSON,
  serializeLibraryAsJSON,
} from "@excalidraw/excalidraw";

import type { GenericRecord } from "./scene_spec.js";

export type ParsedSceneLike = {
  kind: "scene" | "clipboard";
  elements: GenericRecord[];
  appState: GenericRecord;
  files: GenericRecord;
};

export const parseJson = (text: string, label: string): GenericRecord => {
  try {
    return JSON.parse(text) as GenericRecord;
  } catch (error) {
    throw new Error(`Could not parse ${label}: ${(error as Error).message}`);
  }
};

export const getRawDuplicateIds = (elements: GenericRecord[]): string[] => {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const element of elements) {
    if (!element?.id) {
      continue;
    }
    if (seen.has(element.id)) {
      duplicates.add(element.id);
    } else {
      seen.add(element.id);
    }
  }
  return [...duplicates];
};

export const cloneValue = <T>(value: T): T => structuredClone(value);

export const parseSceneLikeText = (
  text: string,
  options?: { refreshDimensions?: boolean },
): ParsedSceneLike => {
  const parsed = parseJson(text, "scene JSON");
  const refreshDimensions = Boolean(options?.refreshDimensions);

  if (parsed.type === "excalidrawlib") {
    throw new Error("This operation expects a scene, not an Excalidraw library.");
  }

  const kind = parsed.type === "excalidraw/clipboard" ? "clipboard" : "scene";
  return {
    kind,
    elements: restoreElements(parsed.elements ?? [], null, {
      refreshDimensions,
      repairBindings: true,
    }) as GenericRecord[],
    appState: restoreAppState(parsed.appState ?? {}, null) as GenericRecord,
    files: cloneValue(parsed.files ?? {}),
  };
};

export const restoreLibraryText = (text: string): { itemsText: string; itemCount: number } => {
  const parsed = parseJson(text, "library JSON");
  const restoredItems = restoreLibraryItems(parsed.libraryItems ?? parsed.items ?? [], "unpublished");
  return {
    itemsText: serializeLibraryAsJSON(restoredItems),
    itemCount: restoredItems.length,
  };
};

export const serializeScene = (elements: GenericRecord[], appState: GenericRecord, files: GenericRecord): string => {
  return serializeAsJSON(elements as any, appState as any, files as any, "local");
};

export const getElementMap = (elements: GenericRecord[]): Map<string, GenericRecord> => {
  return new Map(elements.map((element) => [element.id, element]));
};

export const getBoundTextElement = (
  element: GenericRecord,
  elementMap: Map<string, GenericRecord>,
): GenericRecord | null => {
  const boundTextReference = (element.boundElements ?? []).find((candidate: GenericRecord) => candidate.type === "text");
  return boundTextReference ? (elementMap.get(boundTextReference.id) ?? null) : null;
};

export const getBoundTextElements = (elements: GenericRecord[]): Map<string, GenericRecord> => {
  const elementMap = getElementMap(elements);
  const boundTextByContainer = new Map<string, GenericRecord>();
  for (const element of elements) {
    if (!element || element.type !== "text") {
      continue;
    }
    if (element.containerId && !boundTextByContainer.has(element.containerId)) {
      boundTextByContainer.set(element.containerId, element);
      continue;
    }
  }
  for (const element of elements) {
    if (!element || boundTextByContainer.has(element.id)) {
      continue;
    }
    const boundText = getBoundTextElement(element, elementMap);
    if (boundText) {
      boundTextByContainer.set(element.id, boundText);
    }
  }
  return boundTextByContainer;
};

export const updateTextElement = (element: GenericRecord, label: string): void => {
  element.text = label;
  element.originalText = label;
  if ("rawText" in element) {
    element.rawText = label;
  }
};
