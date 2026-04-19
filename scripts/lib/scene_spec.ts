import { convertToExcalidrawElements, restoreAppState } from "@excalidraw/excalidraw";

export type GenericRecord = Record<string, any>;
export type Point = { x: number; y: number };

export type NodeKind = "rectangle" | "ellipse" | "diamond" | "text";
export type NodeRole =
  | "process"
  | "terminator"
  | "decision"
  | "data"
  | "branch-split"
  | "merge-point"
  | "callout";
export type EdgeKind = "arrow" | "line";
export type LayoutKind = "flow-right" | "flow-down" | "manual";
export type DiagramPreset = "default" | "clean-flowchart";
export type CalloutPlacement = "right" | "left" | "top" | "bottom";

export type DocumentSpec = {
  layout?: LayoutKind;
  theme?: "light" | "dark";
  background?: string;
  padding?: number;
  gapX?: number;
  gapY?: number;
  nodeWidth?: number;
  nodeHeight?: number;
  wrapAt?: number;
  preset?: DiagramPreset;
  laneGap?: number;
  laneHeaderHeight?: number;
  calloutGap?: number;
  maxWarnings?: number;
  minimumEditableElements?: number;
};

export type SceneNodeSpec = {
  id: string;
  kind?: NodeKind;
  role?: NodeRole;
  label?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  lane?: string;
  row?: number;
  column?: number;
  style?: GenericRecord;
  customData?: GenericRecord;
};

export type SceneEdgeSpec = {
  id?: string;
  type?: EdgeKind;
  from: string;
  to: string;
  label?: string;
  style?: GenericRecord;
  customData?: GenericRecord;
};

export type SceneFrameSpec = {
  id?: string;
  name?: string;
  children?: string[];
  style?: GenericRecord;
  customData?: GenericRecord;
};

export type SceneSwimlaneSpec = {
  id: string;
  label: string;
  children?: string[];
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  style?: GenericRecord;
  customData?: GenericRecord;
};

export type SceneOutcomeRowSpec = {
  id?: string;
  parent: string;
  children: string[];
  label?: string;
  lane?: string;
};

export type SceneCalloutSpec = {
  id: string;
  target: string;
  label: string;
  placement?: CalloutPlacement;
  width?: number;
  height?: number;
  style?: GenericRecord;
  customData?: GenericRecord;
};

export type SceneSpec = {
  document?: DocumentSpec;
  nodes?: SceneNodeSpec[];
  edges?: SceneEdgeSpec[];
  frames?: SceneFrameSpec[];
  swimlanes?: SceneSwimlaneSpec[];
  outcomeRows?: SceneOutcomeRowSpec[];
  callouts?: SceneCalloutSpec[];
};

export type RenameOperation = {
  op: "rename";
  id: string;
  label: string;
};

export type MoveOperation = {
  op: "move";
  id: string;
  x: number;
  y: number;
};

export type SetStyleOperation = {
  op: "set-style";
  id: string;
  style?: GenericRecord;
};

export type AddNodeOperation = {
  op: "add-node";
  node: SceneNodeSpec;
};

export type ConnectOperation = SceneEdgeSpec & {
  op: "connect";
};

export type DeleteOperation = {
  op: "delete";
  id: string;
};

export type FrameOperation = SceneFrameSpec & {
  op: "frame";
};

export type PatchOperation =
  | RenameOperation
  | MoveOperation
  | SetStyleOperation
  | AddNodeOperation
  | ConnectOperation
  | DeleteOperation
  | FrameOperation;

export type PatchSpec = {
  operations?: PatchOperation[];
};

type PresetStyleDefaults = {
  node: GenericRecord;
  linear: GenericRecord;
  frame: GenericRecord;
  text: GenericRecord;
};

export const DEFAULT_DOCUMENT: Required<DocumentSpec> = {
  layout: "flow-right",
  theme: "light",
  background: "#ffffff",
  padding: 64,
  gapX: 140,
  gapY: 110,
  nodeWidth: 180,
  nodeHeight: 90,
  wrapAt: 3,
  preset: "default",
  laneGap: 120,
  laneHeaderHeight: 48,
  calloutGap: 32,
  maxWarnings: 0,
  minimumEditableElements: 2,
};

const DEFAULT_FONT_SIZE = 20;
const TEXT_MEASUREMENT_PADDING: Record<NodeKind, { horizontal: number; vertical: number; widthFactor: number; heightFactor: number }> = {
  rectangle: { horizontal: 24, vertical: 16, widthFactor: 1, heightFactor: 1 },
  ellipse: { horizontal: 30, vertical: 20, widthFactor: 0.82, heightFactor: 0.8 },
  diamond: { horizontal: 34, vertical: 24, widthFactor: 0.72, heightFactor: 0.7 },
  text: { horizontal: 0, vertical: 0, widthFactor: 1, heightFactor: 1 },
};

const PRESET_STYLES: Record<DiagramPreset, PresetStyleDefaults> = {
  default: {
    node: {
      strokeWidth: 2,
      roughness: 1,
      fillStyle: "hachure",
      strokeColor: "#1f1f1f",
      backgroundColor: "transparent",
      fontSize: DEFAULT_FONT_SIZE,
      fontFamily: 1,
      roundness: { type: 3 },
    },
    linear: {
      strokeWidth: 2,
      roughness: 1,
      strokeColor: "#1f1f1f",
      endArrowhead: "triangle",
      fontSize: DEFAULT_FONT_SIZE - 2,
      fontFamily: 1,
    },
    frame: {
      strokeColor: "#8b8b8b",
      backgroundColor: "transparent",
      strokeWidth: 1,
      roughness: 1,
      opacity: 100,
    },
    text: {
      fontSize: DEFAULT_FONT_SIZE,
      fontFamily: 1,
      strokeColor: "#1f1f1f",
    },
  },
  "clean-flowchart": {
    node: {
      strokeWidth: 1,
      roughness: 0,
      fillStyle: "solid",
      strokeColor: "#264653",
      backgroundColor: "#ffffff",
      fontSize: 18,
      fontFamily: 2,
      roundness: { type: 3 },
    },
    linear: {
      strokeWidth: 1,
      roughness: 0,
      strokeColor: "#3d5a80",
      endArrowhead: "triangle",
      fontSize: 16,
      fontFamily: 2,
    },
    frame: {
      strokeColor: "#9db4c0",
      backgroundColor: "transparent",
      strokeWidth: 1,
      roughness: 0,
      opacity: 80,
    },
    text: {
      fontSize: 18,
      fontFamily: 2,
      strokeColor: "#17324d",
    },
  },
};

const clamp = (value: number, minimum: number, maximum: number): number => {
  return Math.min(maximum, Math.max(minimum, value));
};

export const mergeDocument = (documentValue?: DocumentSpec): Required<DocumentSpec> => ({
  ...DEFAULT_DOCUMENT,
  ...(documentValue ?? {}),
});

export const getPresetDefaults = (
  documentValue?: DocumentSpec,
  elementType: keyof PresetStyleDefaults = "node",
): GenericRecord => {
  const documentSettings = mergeDocument(documentValue);
  return { ...PRESET_STYLES[documentSettings.preset][elementType] };
};

export const mergePresetStyle = (
  documentValue: DocumentSpec | undefined,
  elementType: keyof PresetStyleDefaults,
  style?: GenericRecord,
): GenericRecord => ({
  ...getPresetDefaults(documentValue, elementType),
  ...(style ?? {}),
});

export const resolveNodeKind = (node: SceneNodeSpec): NodeKind => {
  if (node.kind) {
    return node.kind;
  }

  switch (node.role) {
    case "terminator":
      return "ellipse";
    case "decision":
    case "branch-split":
      return "diamond";
    case "merge-point":
      return "ellipse";
    case "callout":
      return "rectangle";
    case "data":
    case "process":
    default:
      return "rectangle";
  }
};

export const buildAppState = (documentValue?: DocumentSpec, overrides?: GenericRecord): GenericRecord => {
  const documentSettings = mergeDocument(documentValue);
  const textDefaults = getPresetDefaults(documentSettings, "text");
  const lineDefaults = getPresetDefaults(documentSettings, "linear");
  return restoreAppState(
    {
      viewBackgroundColor: documentSettings.background,
      exportBackground: true,
      exportWithDarkMode: documentSettings.theme === "dark",
      theme: documentSettings.theme,
      currentItemRoughness: lineDefaults.roughness,
      currentItemStrokeWidth: lineDefaults.strokeWidth,
      currentItemFontFamily: textDefaults.fontFamily,
      currentItemFontSize: textDefaults.fontSize,
      ...(overrides ?? {}),
    },
    null,
  ) as GenericRecord;
};

const getBaseNodeSize = (node: SceneNodeSpec, documentValue?: DocumentSpec): { width: number; height: number } => {
  const documentSettings = mergeDocument(documentValue);
  const kind = resolveNodeKind(node);
  let width = Number(node.width ?? documentSettings.nodeWidth);
  let height = Number(node.height ?? documentSettings.nodeHeight);

  if (node.role === "merge-point") {
    width = Number(node.width ?? 96);
    height = Number(node.height ?? 96);
  } else if (node.role === "terminator") {
    width = Number(node.width ?? Math.max(documentSettings.nodeWidth, 200));
    height = Number(node.height ?? Math.max(documentSettings.nodeHeight - 6, 84));
  } else if (kind === "diamond" && node.width === undefined) {
    width = Math.max(width, 200);
    height = Math.max(height, 120);
  } else if (kind === "ellipse" && node.width === undefined) {
    width = Math.max(120, Math.round(width * 0.9));
    height = Math.max(72, Math.round(height * 0.88));
  }

  if (node.role === "callout") {
    width = Number(node.width ?? Math.max(width, 220));
    height = Number(node.height ?? Math.max(height, 84));
  }

  return { width, height };
};

const getMeasurementPadding = (kind: NodeKind) => {
  return TEXT_MEASUREMENT_PADDING[kind] ?? TEXT_MEASUREMENT_PADDING.rectangle;
};

const getMeasuredNodeSize = (
  node: SceneNodeSpec,
  kind: NodeKind,
  documentValue?: DocumentSpec,
): { width: number; height: number } | null => {
  if (kind === "text") {
    return null;
  }
  const label = (node.label ?? "").trim();
  if (!label) {
    return null;
  }

  try {
    const style = mergePresetStyle(documentValue, "node", node.style);
    const converted = convertToExcalidrawElements([{
      type: kind,
      id: node.id,
      x: 0,
      y: 0,
      label: { text: label },
      strokeColor: style.strokeColor,
      backgroundColor: style.backgroundColor,
      fillStyle: style.fillStyle,
      strokeWidth: style.strokeWidth,
      strokeStyle: style.strokeStyle,
      roughness: style.roughness,
      opacity: style.opacity,
      roundness: style.roundness,
      fontSize: style.fontSize,
      fontFamily: style.fontFamily,
    }] as any, { regenerateIds: false }) as GenericRecord[];

    const shape = converted.find((element) => element.id === node.id && element.type !== "text");
    if (!shape) {
      return null;
    }
    const boundText = converted.find((element) => element.type === "text" && element.containerId === node.id);
    const baseWidth = Number(shape.width ?? 0);
    const baseHeight = Number(shape.height ?? 0);
    if (!Number.isFinite(baseWidth) || !Number.isFinite(baseHeight) || baseWidth <= 0 || baseHeight <= 0) {
      return null;
    }

    const padding = getMeasurementPadding(kind);
    const textWidth = Number(boundText?.width ?? 0);
    const textHeight = Number(boundText?.height ?? 0);
    const widthFromText = textWidth > 0
      ? Math.round(textWidth / padding.widthFactor + padding.horizontal * 2)
      : baseWidth;
    const heightFromText = textHeight > 0
      ? Math.round(textHeight / padding.heightFactor + padding.vertical * 2)
      : baseHeight;

    return {
      width: Math.max(Math.round(baseWidth), widthFromText),
      height: Math.max(Math.round(baseHeight), heightFromText),
    };
  } catch {
    return null;
  }
};

export const getSizedNode = (node: SceneNodeSpec, documentValue?: DocumentSpec): SceneNodeSpec => {
  const kind = resolveNodeKind(node);
  if (kind === "text") {
    return node;
  }

  const { width: baseWidth, height: baseHeight } = getBaseNodeSize(node, documentValue);
  const label = (node.label ?? "").trim();
  if (!label) {
    return {
      ...node,
      kind,
      width: baseWidth,
      height: baseHeight,
    };
  }

  const measured = getMeasuredNodeSize(node, kind, documentValue);
  if (measured && node.width === undefined && node.height === undefined) {
    return {
      ...node,
      kind,
      width: Math.max(baseWidth, measured.width),
      height: Math.max(baseHeight, measured.height),
    };
  }

  const style = mergePresetStyle(documentValue, "node", node.style);
  const fontSize = Number(style.fontSize ?? DEFAULT_FONT_SIZE);
  const averageCharWidth = fontSize * 0.56;
  const horizontalPadding = kind === "diamond" ? 52 : kind === "ellipse" ? 42 : 28;
  const verticalPadding = kind === "diamond" ? 38 : kind === "ellipse" ? 30 : 24;
  const targetLines = label.length > 110 ? 5 : label.length > 72 ? 4 : label.length > 40 ? 3 : 2;
  const targetCharsPerLine = clamp(Math.ceil(label.length / targetLines), 10, 26);
  const estimatedWidth = Math.max(
    baseWidth,
    Math.min(440, Math.round(targetCharsPerLine * averageCharWidth + horizontalPadding)),
  );
  const estimatedCharsPerLine = Math.max(1, Math.floor((estimatedWidth - horizontalPadding) / averageCharWidth));
  const lineCount = Math.max(1, Math.ceil(label.length / estimatedCharsPerLine));
  const estimatedHeight = Math.max(
    baseHeight,
    Math.round(lineCount * fontSize * 1.22 + verticalPadding),
  );

  return {
    ...node,
    kind,
    width: estimatedWidth,
    height: estimatedHeight,
  };
};

const autoNudgeManualNodes = (nodes: SceneNodeSpec[], documentValue?: DocumentSpec): SceneNodeSpec[] => {
  const documentSettings = mergeDocument(documentValue);
  const gap = Math.max(24, Math.round(Math.min(documentSettings.gapX, documentSettings.gapY) * 0.3));
  const adjusted = nodes.map((node) => ({ ...node }));

  for (let pass = 0; pass < 10; pass += 1) {
    let changed = false;
    for (let index = 0; index < adjusted.length; index += 1) {
      const first = adjusted[index];
      const firstWidth = Number(first.width ?? documentSettings.nodeWidth);
      const firstHeight = Number(first.height ?? documentSettings.nodeHeight);
      const firstRect = {
        minX: Number(first.x ?? documentSettings.padding),
        minY: Number(first.y ?? documentSettings.padding),
        maxX: Number(first.x ?? documentSettings.padding) + firstWidth,
        maxY: Number(first.y ?? documentSettings.padding) + firstHeight,
      };

      for (let inner = index + 1; inner < adjusted.length; inner += 1) {
        const second = adjusted[inner];
        const secondWidth = Number(second.width ?? documentSettings.nodeWidth);
        const secondHeight = Number(second.height ?? documentSettings.nodeHeight);
        const secondRect = {
          minX: Number(second.x ?? documentSettings.padding),
          minY: Number(second.y ?? documentSettings.padding),
          maxX: Number(second.x ?? documentSettings.padding) + secondWidth,
          maxY: Number(second.y ?? documentSettings.padding) + secondHeight,
        };

        const overlapX = Math.min(firstRect.maxX, secondRect.maxX) - Math.max(firstRect.minX, secondRect.minX);
        const overlapY = Math.min(firstRect.maxY, secondRect.maxY) - Math.max(firstRect.minY, secondRect.minY);
        if (overlapX <= 0 || overlapY <= 0) {
          continue;
        }

        if (overlapX <= overlapY) {
          const direction = secondRect.minX >= firstRect.minX ? 1 : -1;
          second.x = Number(second.x ?? documentSettings.padding) + direction * (overlapX + gap);
        } else {
          const direction = secondRect.minY >= firstRect.minY ? 1 : -1;
          second.y = Number(second.y ?? documentSettings.padding) + direction * (overlapY + gap);
        }
        changed = true;
      }
    }
    if (!changed) {
      break;
    }
  }

  return adjusted;
};

export const layoutNodes = (nodes: SceneNodeSpec[], documentValue?: DocumentSpec): SceneNodeSpec[] => {
  const documentSettings = mergeDocument(documentValue);
  const sizedNodes = nodes.map((node) => getSizedNode(node, documentValue));

  if (documentSettings.layout === "manual") {
    const manualNodes = sizedNodes.map((node) => ({
      ...node,
      x: typeof node.x === "number" ? node.x : documentSettings.padding,
      y: typeof node.y === "number" ? node.y : documentSettings.padding,
    }));
    return autoNudgeManualNodes(manualNodes, documentValue);
  }

  const wrapAt = Math.max(1, Number(documentSettings.wrapAt ?? 3));
  const positioned: SceneNodeSpec[] = [];

  if (documentSettings.layout === "flow-down") {
    let currentX = documentSettings.padding;
    for (let start = 0; start < sizedNodes.length; start += wrapAt) {
      const column = sizedNodes.slice(start, start + wrapAt);
      let currentY = documentSettings.padding;
      const columnWidth = Math.max(...column.map((node) => Number(node.width ?? documentSettings.nodeWidth)));
      for (const node of column) {
        positioned.push({
          ...node,
          x: typeof node.x === "number" ? node.x : currentX,
          y: typeof node.y === "number" ? node.y : currentY,
        });
        currentY += Number(node.height ?? documentSettings.nodeHeight) + documentSettings.gapY;
      }
      currentX += columnWidth + documentSettings.gapX;
    }
    return positioned;
  }

  let currentY = documentSettings.padding;
  for (let start = 0; start < sizedNodes.length; start += wrapAt) {
    const row = sizedNodes.slice(start, start + wrapAt);
    let currentX = documentSettings.padding;
    const rowHeight = Math.max(...row.map((node) => Number(node.height ?? documentSettings.nodeHeight)));
    for (const node of row) {
      positioned.push({
        ...node,
        x: typeof node.x === "number" ? node.x : currentX,
        y: typeof node.y === "number" ? node.y : currentY,
      });
      currentX += Number(node.width ?? documentSettings.nodeWidth) + documentSettings.gapX;
    }
    currentY += rowHeight + documentSettings.gapY;
  }
  return positioned;
};

export const buildNodeSkeleton = (node: SceneNodeSpec, documentValue?: DocumentSpec): GenericRecord => {
  const documentSettings = mergeDocument(documentValue);
  const kind = resolveNodeKind(node);
  const sizedNode = kind === "text" ? node : getSizedNode(node, documentValue);
  const width = Number(sizedNode.width ?? documentSettings.nodeWidth);
  const height = Number(sizedNode.height ?? documentSettings.nodeHeight);
  const style = mergePresetStyle(documentSettings, kind === "text" ? "text" : "node", sizedNode.style);
  const common = {
    id: sizedNode.id,
    x: Number(sizedNode.x ?? documentSettings.padding),
    y: Number(sizedNode.y ?? documentSettings.padding),
    width,
    height,
    strokeColor: style.strokeColor,
    backgroundColor: style.backgroundColor,
    fillStyle: style.fillStyle,
    strokeWidth: style.strokeWidth,
    strokeStyle: style.strokeStyle,
    roughness: style.roughness,
    opacity: style.opacity,
    roundness: style.roundness,
    fontSize: style.fontSize,
    fontFamily: style.fontFamily,
    customData: {
      ...(sizedNode.customData ?? {}),
      role: sizedNode.role ?? sizedNode.customData?.role,
      lane: sizedNode.lane ?? sizedNode.customData?.lane,
    },
  };

  if (kind === "text") {
    return {
      type: "text",
      id: sizedNode.id,
      x: common.x,
      y: common.y,
      text: sizedNode.label ?? "",
      fontSize: style.fontSize,
      fontFamily: style.fontFamily,
      textAlign: style.textAlign,
      verticalAlign: style.verticalAlign,
      strokeColor: style.strokeColor,
      backgroundColor: style.backgroundColor,
      customData: common.customData,
    };
  }

  return {
    ...common,
    type: kind,
    label: sizedNode.label ? { text: sizedNode.label } : undefined,
  };
};

const getCenter = (element: GenericRecord) => ({
  x: element.x + (element.width ?? 0) / 2,
  y: element.y + (element.height ?? 0) / 2,
});

const getConnectionPoint = (source: GenericRecord, target: GenericRecord): Point => {
  const sourceCenter = getCenter(source);
  const targetCenter = getCenter(target);
  const deltaX = targetCenter.x - sourceCenter.x;
  const deltaY = targetCenter.y - sourceCenter.y;
  const width = Math.max(1, Number(source.width ?? 0));
  const height = Math.max(1, Number(source.height ?? 0));

  if (Math.abs(deltaX) >= Math.abs(deltaY)) {
    return {
      x: sourceCenter.x + Math.sign(deltaX || 1) * width / 2,
      y: sourceCenter.y,
    };
  }

  return {
    x: sourceCenter.x,
    y: sourceCenter.y + Math.sign(deltaY || 1) * height / 2,
  };
};

export const buildEdgeSkeleton = (edge: SceneEdgeSpec, lookup?: Map<string, GenericRecord>, documentValue?: DocumentSpec): GenericRecord => {
  const fromElement = lookup?.get(edge.from);
  const toElement = lookup?.get(edge.to);
  if (lookup) {
    if (!fromElement) {
      throw new Error(`Edge ${edge.id ?? `${edge.from}->${edge.to}`} references missing "from" node: ${edge.from}`);
    }
    if (!toElement) {
      throw new Error(`Edge ${edge.id ?? `${edge.from}->${edge.to}`} references missing "to" node: ${edge.to}`);
    }
  }
  const routePoints = Array.isArray(edge.customData?.routePoints)
    ? edge.customData.routePoints
      .map((point: GenericRecord) => ({
        x: Number(point?.x),
        y: Number(point?.y),
      }))
      .filter((point: Point) => Number.isFinite(point.x) && Number.isFinite(point.y))
    : null;
  const startPoint = routePoints && routePoints.length >= 2
    ? routePoints[0]
    : fromElement && toElement
    ? getConnectionPoint(fromElement, toElement)
    : { x: 0, y: 0 };
  const endPoint = routePoints && routePoints.length >= 2
    ? routePoints[routePoints.length - 1]
    : fromElement && toElement
    ? getConnectionPoint(toElement, fromElement)
    : { x: 200, y: 0 };
  const style = mergePresetStyle(documentValue, "linear", edge.style);
  const points = routePoints && routePoints.length >= 2
    ? routePoints.map((point: Point) => [point.x - startPoint.x, point.y - startPoint.y])
    : [
        [0, 0],
        [endPoint.x - startPoint.x, endPoint.y - startPoint.y],
      ];
  return {
    type: edge.type ?? "arrow",
    id: edge.id,
    x: startPoint.x,
    y: startPoint.y,
    points,
    label: edge.label ? { text: edge.label } : undefined,
    start: fromElement ? { id: edge.from } : undefined,
    end: toElement ? { id: edge.to } : undefined,
    strokeColor: style.strokeColor,
    backgroundColor: style.backgroundColor,
    strokeWidth: style.strokeWidth,
    strokeStyle: style.strokeStyle,
    roughness: style.roughness,
    opacity: style.opacity,
    fontSize: style.fontSize,
    fontFamily: style.fontFamily,
    startArrowhead: edge.type === "line" ? null : style.startArrowhead,
    endArrowhead: edge.type === "line" ? null : (style.endArrowhead ?? "triangle"),
    customData: {
      ...(edge.customData ?? {}),
      fromId: edge.from,
      toId: edge.to,
    },
  };
};

export const buildFrameSkeleton = (frame: SceneFrameSpec, documentValue?: DocumentSpec): GenericRecord => {
  const style = mergePresetStyle(documentValue, "frame", frame.style);
  return {
    type: "frame",
    id: frame.id,
    name: frame.name,
    children: frame.children ?? [],
    strokeColor: style.strokeColor,
    backgroundColor: style.backgroundColor,
    strokeWidth: style.strokeWidth,
    roughness: style.roughness,
    opacity: style.opacity,
    customData: frame.customData,
  };
};
