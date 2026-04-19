import {
  convertToExcalidrawElements,
  isInvisiblySmallElement,
  restoreElements,
} from "@excalidraw/excalidraw";

import {
  buildAppState,
  buildEdgeSkeleton,
  buildFrameSkeleton,
  buildNodeSkeleton,
  getPresetDefaults,
  layoutNodes,
  mergeDocument,
  type SceneEdgeSpec,
  type SceneCalloutSpec,
  type GenericRecord,
  type PatchSpec,
  type SceneFrameSpec,
  type SceneOutcomeRowSpec,
  type SceneSpec,
  type SceneSwimlaneSpec,
  type Point,
} from "./scene_spec.js";
import {
  cloneValue,
  getBoundTextElement,
  getBoundTextElements,
  getElementMap,
  getRawDuplicateIds,
  parseJson,
  parseSceneLikeText,
  restoreLibraryText,
  serializeScene,
  updateTextElement,
} from "./normalize.js";
import { buildLayoutGraph, selectLayoutEngine, assignOutcomeRowsToNodes } from "./layout_graph.js";
import { layoutGraphWithElk } from "./layout_elk.js";

type Rect = { minX: number; minY: number; maxX: number; maxY: number };
type Severity = "error" | "warning" | "info";
type RouteHistoryEntry = {
  bestScore: number;
  attemptedSignatures: Set<string>;
};

const MAX_CANVAS_EXTENT = 5000;
const MAX_AUTO_REPAIR_PASSES = 4;
const ROUTE_RELATED_FINDING_CODES = new Set([
  "edge-node-crossing",
  "edge-edge-crossing",
  "edge-label-overlap",
  "detached-arrow",
  "same-rank-bent-edge",
]);

export type QualityFinding = {
  code: string;
  message: string;
  severity: Severity;
  elements?: string[];
};

const elementToHelperSkeleton = (element: GenericRecord, elementMap: Map<string, GenericRecord>): GenericRecord | null => {
  if (element.type === "text") {
    return {
      type: "text",
      id: element.id,
      x: element.x,
      y: element.y,
      text: element.originalText ?? element.text ?? "",
      fontSize: element.fontSize,
      fontFamily: element.fontFamily,
      textAlign: element.textAlign,
      verticalAlign: element.verticalAlign,
      strokeColor: element.strokeColor,
      backgroundColor: element.backgroundColor,
    };
  }

  if (["rectangle", "ellipse", "diamond"].includes(element.type)) {
    const boundText = getBoundTextElement(element, elementMap);
    return {
      type: element.type,
      id: element.id,
      x: element.x,
      y: element.y,
      width: element.width,
      height: element.height,
      label: boundText ? { text: boundText.originalText ?? boundText.text ?? "" } : undefined,
      strokeColor: element.strokeColor,
      backgroundColor: element.backgroundColor,
      fillStyle: element.fillStyle,
      strokeWidth: element.strokeWidth,
      strokeStyle: element.strokeStyle,
      roughness: element.roughness,
      opacity: element.opacity,
      roundness: element.roundness,
    };
  }

  return null;
};

const removeElementById = (elements: GenericRecord[], targetId: string): GenericRecord[] => {
  const removalSet = new Set<string>([targetId]);
  const originalMap = getElementMap(elements);
  const target = originalMap.get(targetId);
  if (target) {
    const boundText = getBoundTextElement(target, originalMap);
    if (boundText) {
      removalSet.add(boundText.id);
    }
  }

  return elements
    .filter((element) => {
      if (removalSet.has(element.id)) {
        return false;
      }
      if (element.containerId && removalSet.has(element.containerId)) {
        return false;
      }
      if (element.startBinding?.elementId && removalSet.has(element.startBinding.elementId)) {
        return false;
      }
      if (element.endBinding?.elementId && removalSet.has(element.endBinding.elementId)) {
        return false;
      }
      return true;
    })
    .map((element) => {
      const nextElement = cloneValue(element);
      if (nextElement.boundElements) {
        nextElement.boundElements = nextElement.boundElements.filter((reference: GenericRecord) => !removalSet.has(reference.id));
      }
      if (nextElement.frameId && removalSet.has(nextElement.frameId)) {
        nextElement.frameId = null;
      }
      return nextElement;
    });
};

const expandRect = (rect: Rect, padding: number): Rect => ({
  minX: rect.minX - padding,
  minY: rect.minY - padding,
  maxX: rect.maxX + padding,
  maxY: rect.maxY + padding,
});

const getRectForElement = (element: GenericRecord): Rect => ({
  minX: element.x,
  minY: element.y,
  maxX: element.x + (element.width ?? 0),
  maxY: element.y + (element.height ?? 0),
});

const getPolylinePoints = (element: GenericRecord): Point[] => {
  const points = Array.isArray(element.points) ? element.points : [];
  const baseX = Number(element.x ?? 0);
  const baseY = Number(element.y ?? 0);
  if (points.length === 0) {
    return [{ x: baseX, y: baseY }];
  }
  return points.map(([deltaX, deltaY]: [number, number]) => ({
    x: baseX + deltaX,
    y: baseY + deltaY,
  }));
};

const getPolylineLength = (points: Point[]): number => {
  let total = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    total += Math.hypot(points[index + 1].x - points[index].x, points[index + 1].y - points[index].y);
  }
  return total;
};

const getPointAtDistance = (points: Point[], distance: number): Point => {
  if (points.length === 0) {
    return { x: 0, y: 0 };
  }
  if (points.length === 1 || distance <= 0) {
    return points[0];
  }

  let remaining = distance;
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    const segmentLength = Math.hypot(end.x - start.x, end.y - start.y);
    if (segmentLength <= 0.0001) {
      continue;
    }
    if (remaining <= segmentLength) {
      const ratio = remaining / segmentLength;
      return {
        x: start.x + (end.x - start.x) * ratio,
        y: start.y + (end.y - start.y) * ratio,
      };
    }
    remaining -= segmentLength;
  }

  return points[points.length - 1];
};

const getDirectDistance = (start: Point, end: Point): number => {
  return Math.hypot(end.x - start.x, end.y - start.y);
};

const getMedian = (values: number[]): number => {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle];
  }
  return (sorted[middle - 1] + sorted[middle]) / 2;
};

const pointInRect = (point: Point, rect: Rect): boolean => {
  return point.x > rect.minX && point.x < rect.maxX && point.y > rect.minY && point.y < rect.maxY;
};

const orientation = (a: Point, b: Point, c: Point): number => {
  const value = (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y);
  if (Math.abs(value) < 0.0001) {
    return 0;
  }
  return value > 0 ? 1 : 2;
};

const onSegment = (a: Point, b: Point, c: Point): boolean => {
  return (
    b.x <= Math.max(a.x, c.x) &&
    b.x >= Math.min(a.x, c.x) &&
    b.y <= Math.max(a.y, c.y) &&
    b.y >= Math.min(a.y, c.y)
  );
};

const segmentsIntersect = (a1: Point, a2: Point, b1: Point, b2: Point): boolean => {
  const o1 = orientation(a1, a2, b1);
  const o2 = orientation(a1, a2, b2);
  const o3 = orientation(b1, b2, a1);
  const o4 = orientation(b1, b2, a2);

  if (o1 != o2 && o3 != o4) {
    return true;
  }
  if (o1 === 0 && onSegment(a1, b1, a2)) {
    return true;
  }
  if (o2 === 0 && onSegment(a1, b2, a2)) {
    return true;
  }
  if (o3 === 0 && onSegment(b1, a1, b2)) {
    return true;
  }
  if (o4 === 0 && onSegment(b1, a2, b2)) {
    return true;
  }
  return false;
};

const segmentIntersectsRect = (start: Point, end: Point, rect: Rect): boolean => {
  if (pointInRect(start, rect) || pointInRect(end, rect)) {
    return true;
  }

  const topLeft = { x: rect.minX, y: rect.minY };
  const topRight = { x: rect.maxX, y: rect.minY };
  const bottomLeft = { x: rect.minX, y: rect.maxY };
  const bottomRight = { x: rect.maxX, y: rect.maxY };

  return [
    [topLeft, topRight],
    [topRight, bottomRight],
    [bottomRight, bottomLeft],
    [bottomLeft, topLeft],
  ].some(([edgeStart, edgeEnd]) => segmentsIntersect(start, end, edgeStart, edgeEnd));
};

const sharesEndpoint = (first: Point, second: Point, tolerance = 2): boolean => {
  return Math.abs(first.x - second.x) <= tolerance && Math.abs(first.y - second.y) <= tolerance;
};

const rectsOverlap = (a: Rect, b: Rect, tolerance = 1): boolean => {
  return (
    a.minX + tolerance < b.maxX &&
    a.maxX - tolerance > b.minX &&
    a.minY + tolerance < b.maxY &&
    a.maxY - tolerance > b.minY
  );
};

const rectContainsRect = (outer: Rect, inner: Rect, tolerance = 0): boolean => {
  return (
    inner.minX >= outer.minX - tolerance &&
    inner.maxX <= outer.maxX + tolerance &&
    inner.minY >= outer.minY - tolerance &&
    inner.maxY <= outer.maxY + tolerance
  );
};

const getShapeTextInsets = (element: GenericRecord): { widthFactor: number; heightFactor: number } => {
  switch (element.type) {
    case "ellipse":
      return { widthFactor: 0.82, heightFactor: 0.8 };
    case "diamond":
      return { widthFactor: 0.72, heightFactor: 0.7 };
    default:
      return { widthFactor: 1, heightFactor: 1 };
  }
};

const getEffectiveTextArea = (element: GenericRecord): { width: number; height: number } => {
  const insets = getShapeTextInsets(element);
  return {
    width: Math.max(1, Number(element.width ?? 0) * insets.widthFactor),
    height: Math.max(1, Number(element.height ?? 0) * insets.heightFactor),
  };
};

const measureTextBox = (text: string, fontSize: number): { width: number; height: number } => {
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  const normalizedLines = lines.length > 0 ? lines : [text];
  const longestLine = normalizedLines.reduce((longest, line) => Math.max(longest, line.length), 0);
  return {
    width: Math.max(12, Math.round(longestLine * fontSize * 0.56 + fontSize * 0.8)),
    height: Math.max(fontSize * 1.2, Math.round(normalizedLines.length * fontSize * 1.25)),
  };
};

const getLinearLabelBox = (
  linear: GenericRecord,
  elementMap: Map<string, GenericRecord>,
  points: Point[],
): Rect | null => {
  const boundText = getBoundTextElement(linear, elementMap);
  const labelText = boundText?.originalText ?? boundText?.text ?? linear.label?.text ?? linear.customData?.label;
  if (typeof labelText !== "string" || labelText.trim().length === 0) {
    return null;
  }

  const fontSize = Number(boundText?.fontSize ?? linear.fontSize ?? 16);
  const measured = boundText && Number.isFinite(Number(boundText.width)) && Number.isFinite(Number(boundText.height))
    ? { width: Number(boundText.width), height: Number(boundText.height) }
    : measureTextBox(labelText, fontSize);
  const totalLength = getPolylineLength(points);
  const center = getPointAtDistance(points, totalLength / 2);

  return {
    minX: center.x - measured.width / 2,
    minY: center.y - measured.height / 2,
    maxX: center.x + measured.width / 2,
    maxY: center.y + measured.height / 2,
  };
};

const isAuxiliaryLayoutElement = (element: GenericRecord): boolean => {
  const role = element.customData?.role;
  return role === "lane-background" || role === "callout-connector";
};

const getQualityWarnings = (elements: GenericRecord[]) => {
  const findings: QualityFinding[] = [];
  const elementMap = getElementMap(elements);
  const nonDeleted = elements.filter((element) => !element.isDeleted);
  const linears = nonDeleted.filter((element) => (
    (element.type === "arrow" || element.type === "line") &&
    !isAuxiliaryLayoutElement(element)
  ));
  const blockers = nonDeleted.filter((element) => (
    !["arrow", "line", "frame", "magicframe", "selection"].includes(element.type) &&
    !isAuxiliaryLayoutElement(element)
  ));
  const overlapCandidates = nonDeleted.filter((element) =>
    ["rectangle", "ellipse", "diamond", "image"].includes(element.type) &&
    !isAuxiliaryLayoutElement(element),
  );
  const textElements = nonDeleted.filter((element) => element.type === "text");
  const containerTextMap = getBoundTextElements(nonDeleted);

  let edgeNodeCrossings = 0;
  let edgeEdgeCrossings = 0;
  let disconnectedArrows = 0;
  let nodeOverlaps = 0;
  let labelOverflows = 0;
  let edgeLabelOverlaps = 0;
  let textOverlaps = 0;
  let crowdedLabels = 0;
  let diagramSprawl = 0;
  let maxEdgeLength = 0;
  let occupancyRatio = 0;
  let sameRankBentEdgeCount = 0;
  let worstEdgeDetourRatio = 1;
  let longEdgeNormalized = 0;

  const pushFinding = (
    code: string,
    message: string,
    severity: Severity = "warning",
    elementIds?: string[],
  ) => {
    findings.push({ code, message, severity, elements: elementIds });
  };

  for (let index = 0; index < overlapCandidates.length; index += 1) {
    for (let inner = index + 1; inner < overlapCandidates.length; inner += 1) {
      const first = overlapCandidates[index];
      const second = overlapCandidates[inner];
      if (first.containerId === second.id || second.containerId === first.id) {
        continue;
      }
      if (first.frameId === second.id || second.frameId === first.id) {
        continue;
      }
      const rectA = getRectForElement(first);
      const rectB = getRectForElement(second);
      if (rectsOverlap(rectA, rectB, 2)) {
        nodeOverlaps += 1;
        pushFinding(
          "node-overlap",
          `node ${first.id} (${first.type}) overlaps node ${second.id} (${second.type})`,
          "warning",
          [first.id, second.id],
        );
      }
    }
  }

  for (const linear of linears) {
    const points = getPolylinePoints(linear);
    if (points.length === 0) {
      continue;
    }
    const start = points[0];
    const end = points[points.length - 1];

    const checkBinding = (binding: GenericRecord | undefined, point: Point, label: "start" | "end") => {
      if (!binding?.elementId) {
        return;
      }
      const bound = elementMap.get(binding.elementId);
      if (!bound) {
        disconnectedArrows += 1;
        pushFinding(
          "detached-arrow",
          `arrow ${linear.id} ${label} binding target ${binding.elementId} is missing`,
          "error",
          [linear.id, binding.elementId],
        );
        return;
      }
      const rect = expandRect(getRectForElement(bound), 24);
      if (!(point.x >= rect.minX && point.x <= rect.maxX && point.y >= rect.minY && point.y <= rect.maxY)) {
        disconnectedArrows += 1;
        pushFinding(
          "detached-arrow",
          `arrow ${linear.id} ${label} is detached from bound ${bound.type} ${bound.id}`,
          "warning",
          [linear.id, bound.id],
        );
      }
    };

    checkBinding(linear.startBinding, start, "start");
    checkBinding(linear.endBinding, end, "end");

    let totalLength = 0;
    for (let index = 0; index < points.length - 1; index += 1) {
      const dx = points[index + 1].x - points[index].x;
      const dy = points[index + 1].y - points[index].y;
      totalLength += Math.hypot(dx, dy);
    }
    maxEdgeLength = Math.max(maxEdgeLength, totalLength);

    const directDistance = getDirectDistance(start, end);
    if (directDistance > 1) {
      const detourRatio = totalLength / directDistance;
      worstEdgeDetourRatio = Math.max(worstEdgeDetourRatio, detourRatio);
      const horizontallyAligned = Math.abs(start.y - end.y) <= 24;
      const verticallyAligned = Math.abs(start.x - end.x) <= 24;
      if ((horizontallyAligned || verticallyAligned) && points.length > 2 && detourRatio > 1.05) {
        sameRankBentEdgeCount += 1;
        if (detourRatio > 3.25) {
          pushFinding(
            "same-rank-bent-edge",
            `edge ${linear.id} is bent despite aligned endpoints (detour ratio ${Math.round(detourRatio * 100) / 100})`,
            "warning",
            [linear.id],
          );
        }
      }
    }
  }

  for (const container of overlapCandidates) {
    const text = containerTextMap.get(container.id);
    if (!text || ["arrow", "line", "frame", "magicframe", "selection"].includes(container.type)) {
      continue;
    }
    const textRect = getRectForElement(text);
    const allowedRect = expandRect(getRectForElement(container), 12);
    if (!rectContainsRect(allowedRect, textRect)) {
      labelOverflows += 1;
      pushFinding(
        "label-overflow",
        `label ${text.id} overflows ${container.type} ${container.id}`,
        "warning",
        [container.id, text.id],
      );
    }

    const effectiveArea = getEffectiveTextArea(container);
    const textWidth = Math.max(1, textRect.maxX - textRect.minX);
    const textHeight = Math.max(1, textRect.maxY - textRect.minY);
    const fillWidth = textWidth / effectiveArea.width;
    const fillHeight = textHeight / effectiveArea.height;
    const lineEstimate = Math.max(1, Math.round(textHeight / 24));
    const labelText = String(text.originalText ?? text.text ?? "");
    const denseMultiline = lineEstimate >= 3 && labelText.length >= 48 && (fillWidth > 0.68 || fillHeight > 0.58);
    if (fillWidth > 0.82 || fillHeight > 0.74 || lineEstimate >= 5 || denseMultiline) {
      crowdedLabels += 1;
      pushFinding(
        "crowded-label",
        `label ${text.id} nearly fills ${container.type} ${container.id} (${Math.round(fillWidth * 100)}% x ${Math.round(fillHeight * 100)}%, ~${lineEstimate} lines)`,
        "warning",
        [container.id, text.id],
      );
    }
  }

  for (const linear of linears) {
    const points = getPolylinePoints(linear);
    const labelRect = getLinearLabelBox(linear, elementMap, points);
    if (!labelRect) {
      continue;
    }
    const fromId = linear.customData?.fromId ?? linear.startBinding?.elementId;
    const toId = linear.customData?.toId ?? linear.endBinding?.elementId;
    for (const blocker of overlapCandidates) {
      const blockerRect = getRectForElement(blocker);
      const expandedBlockerRect = expandRect(blockerRect, blocker.id === fromId || blocker.id === toId ? 4 : 2);
      if (!rectsOverlap(labelRect, expandedBlockerRect, 0)) {
        continue;
      }
      edgeLabelOverlaps += 1;
      pushFinding(
        "edge-label-overlap",
        `label for edge ${linear.id} overlaps ${blocker.type} ${blocker.id}`,
        "warning",
        [linear.id, blocker.id],
      );
      break;
    }
  }

  for (let index = 0; index < textElements.length; index += 1) {
    for (let inner = index + 1; inner < textElements.length; inner += 1) {
      const first = textElements[index];
      const second = textElements[inner];
      if (first.containerId && first.containerId === second.containerId) {
        continue;
      }
      const rectA = getRectForElement(first);
      const rectB = getRectForElement(second);
      if (rectsOverlap(rectA, rectB, 2)) {
        textOverlaps += 1;
        pushFinding("text-overlap", `text ${first.id} overlaps text ${second.id}`, "warning", [first.id, second.id]);
      }
    }
  }

  for (const linear of linears) {
    const points = getPolylinePoints(linear);
    const fromId = linear.customData?.fromId ?? linear.startBinding?.elementId;
    const toId = linear.customData?.toId ?? linear.endBinding?.elementId;

    for (let index = 0; index < points.length - 1; index += 1) {
      const start = points[index];
      const end = points[index + 1];

      for (const blocker of blockers) {
        if (blocker.id === fromId || blocker.id === toId) {
          continue;
        }
        if (blocker.containerId === linear.id) {
          continue;
        }
        if (blocker.containerId && (blocker.containerId === fromId || blocker.containerId === toId)) {
          continue;
        }
        const rect = expandRect(getRectForElement(blocker), blocker.type === "text" ? 6 : 10);
        if (pointInRect(start, rect) || pointInRect(end, rect)) {
          continue;
        }
        if (segmentIntersectsRect(start, end, rect)) {
          edgeNodeCrossings += 1;
          pushFinding(
            "edge-node-crossing",
            `edge ${linear.id} crosses ${blocker.type} ${blocker.id}`,
            "warning",
            [linear.id, blocker.id],
          );
          break;
        }
      }
    }
  }

  for (let index = 0; index < linears.length; index += 1) {
    for (let inner = index + 1; inner < linears.length; inner += 1) {
      const firstPoints = getPolylinePoints(linears[index]);
      const secondPoints = getPolylinePoints(linears[inner]);
      let foundCrossing = false;

      for (let firstIndex = 0; firstIndex < firstPoints.length - 1 && !foundCrossing; firstIndex += 1) {
        for (let secondIndex = 0; secondIndex < secondPoints.length - 1 && !foundCrossing; secondIndex += 1) {
          const a1 = firstPoints[firstIndex];
          const a2 = firstPoints[firstIndex + 1];
          const b1 = secondPoints[secondIndex];
          const b2 = secondPoints[secondIndex + 1];

          if (
            sharesEndpoint(a1, b1) ||
            sharesEndpoint(a1, b2) ||
            sharesEndpoint(a2, b1) ||
            sharesEndpoint(a2, b2)
          ) {
            continue;
          }
          if (segmentsIntersect(a1, a2, b1, b2)) {
            edgeEdgeCrossings += 1;
            pushFinding(
              "edge-edge-crossing",
              `edge ${linears[index].id} crosses edge ${linears[inner].id}`,
              "warning",
              [linears[index].id, linears[inner].id],
            );
            foundCrossing = true;
          }
        }
      }
    }
  }

  const boundedElements = nonDeleted.filter((element) => (
    !["arrow", "line", "frame", "magicframe", "selection"].includes(element.type) &&
    !isAuxiliaryLayoutElement(element)
  ));
  if (boundedElements.length > 0) {
    const bounds = boundedElements.reduce((accumulator, element) => {
      const rect = getRectForElement(element);
      return {
        minX: Math.min(accumulator.minX, rect.minX),
        minY: Math.min(accumulator.minY, rect.minY),
        maxX: Math.max(accumulator.maxX, rect.maxX),
        maxY: Math.max(accumulator.maxY, rect.maxY),
      };
    }, getRectForElement(boundedElements[0]));

    const diagramArea = Math.max(1, (bounds.maxX - bounds.minX) * (bounds.maxY - bounds.minY));
    const occupiedArea = boundedElements.reduce((sum, element) => {
      const rect = getRectForElement(element);
      return sum + Math.max(1, (rect.maxX - rect.minX) * (rect.maxY - rect.minY));
    }, 0);
    occupancyRatio = occupiedArea / diagramArea;
    if (diagramArea > 1_000_000 && occupancyRatio < 0.05) {
      diagramSprawl += 1;
      pushFinding(
        "diagram-sprawl",
        `diagram is sparse: occupied area is ${Math.round(occupancyRatio * 1000) / 10}% of the bounding box`,
        "error",
      );
    }

    const nodeDimensions = boundedElements
      .map((element) => Math.max(Number(element.width ?? 0), Number(element.height ?? 0)))
      .filter((dimension) => Number.isFinite(dimension) && dimension > 0);
    const medianNodeDimension = getMedian(nodeDimensions);
    if (medianNodeDimension > 0) {
      longEdgeNormalized = maxEdgeLength / medianNodeDimension;
    }
  }

  return {
    warnings: findings.map((finding) => finding.message),
    findings,
    metrics: {
      edgeNodeCrossings,
      edgeEdgeCrossings,
      disconnectedArrows,
      nodeOverlaps,
      labelOverflows,
      edgeLabelOverlaps,
      textOverlaps,
      crowdedLabels,
      diagramSprawl,
      occupancyRatio: Math.round(occupancyRatio * 1000) / 1000,
      maxEdgeLength: Math.round(maxEdgeLength),
      sameRankBentEdgeCount,
      worstEdgeDetourRatio: Math.round(worstEdgeDetourRatio * 100) / 100,
      longEdgeNormalized: Math.round(longEdgeNormalized * 100) / 100,
    },
  };
};

export const inspectSceneData = (
  elements: GenericRecord[],
  files: GenericRecord,
  inputKind: string,
  rawDuplicateIds: string[] = [],
) => {
  const elementMap = getElementMap(elements);
  const seen = new Set<string>();
  const duplicates = new Set<string>(rawDuplicateIds);
  const missingFileIds: string[] = [];
  const referencedFileIds = new Set<string>();
  const invisibleIds: string[] = [];
  const bindingIssues: string[] = [];
  const frameIssues: string[] = [];

  for (const element of elements) {
    if (seen.has(element.id)) {
      duplicates.add(element.id);
    }
    seen.add(element.id);

    if (!element.isDeleted && isInvisiblySmallElement(element as any)) {
      invisibleIds.push(element.id);
    }

    if (element.type === "image" && element.fileId) {
      referencedFileIds.add(element.fileId);
      if (!files[element.fileId]) {
        missingFileIds.push(element.fileId);
      }
    }

    if (element.startBinding?.elementId && !elementMap.has(element.startBinding.elementId)) {
      bindingIssues.push(`${element.id}: missing startBinding target ${element.startBinding.elementId}`);
    }
    if (element.endBinding?.elementId && !elementMap.has(element.endBinding.elementId)) {
      bindingIssues.push(`${element.id}: missing endBinding target ${element.endBinding.elementId}`);
    }
    if (element.containerId && !elementMap.has(element.containerId)) {
      bindingIssues.push(`${element.id}: missing container ${element.containerId}`);
    }
    if (element.frameId && !elementMap.has(element.frameId)) {
      frameIssues.push(`${element.id}: missing frame ${element.frameId}`);
    }
  }

  for (const element of elements) {
    if (!element.frameId || element.isDeleted) {
      continue;
    }
    if (element.type === "arrow" || element.type === "line") {
      continue;
    }
    const container = element.containerId ? elementMap.get(element.containerId) : null;
    if (container && (container.type === "arrow" || container.type === "line")) {
      continue;
    }
    const frame = elementMap.get(element.frameId);
    if (!frame || frame.isDeleted || (frame.type !== "frame" && frame.type !== "magicframe")) {
      continue;
    }
    const frameRect = expandRect(getRectForElement(frame), 6);
    const elementRect = getRectForElement(element);
    if (!rectContainsRect(frameRect, elementRect, 0)) {
      frameIssues.push(`${element.id}: not contained by frame ${frame.id}`);
    }
  }

  const orphanedFileIds = Object.keys(files).filter((fileId) => !referencedFileIds.has(fileId));
  const nonDeleted = elements.filter((element) => !element.isDeleted);
  const elementTypeCounts = nonDeleted.reduce<Record<string, number>>((counts, element) => {
    counts[element.type] = (counts[element.type] ?? 0) + 1;
    return counts;
  }, {});
  const shapeElementCount = nonDeleted.filter((element) =>
    ["rectangle", "ellipse", "diamond"].includes(element.type) && !isAuxiliaryLayoutElement(element)
  ).length;
  const linearElementCount = nonDeleted.filter((element) => (
    (element.type === "arrow" || element.type === "line") &&
    !isAuxiliaryLayoutElement(element)
  )).length;
  const imageElementCount = nonDeleted.filter((element) => element.type === "image").length;
  const frameCount = nonDeleted.filter((element) => element.type === "frame" || element.type === "magicframe").length;
  const textElementCount = nonDeleted.filter((element) => element.type === "text").length;
  const quality = getQualityWarnings(elements);
  const bounds = nonDeleted.length === 0
    ? null
    : nonDeleted.reduce((accumulator, element) => {
      const minX = Math.min(accumulator.minX, element.x);
      const minY = Math.min(accumulator.minY, element.y);
      const maxX = Math.max(accumulator.maxX, element.x + (element.width ?? 0));
      const maxY = Math.max(accumulator.maxY, element.y + (element.height ?? 0));
      return { minX, minY, maxX, maxY };
    }, {
      minX: nonDeleted[0].x,
      minY: nonDeleted[0].y,
      maxX: nonDeleted[0].x + (nonDeleted[0].width ?? 0),
      maxY: nonDeleted[0].y + (nonDeleted[0].height ?? 0),
    });

  return {
    inputKind,
    totalElements: elements.length,
    nonDeletedElements: nonDeleted.length,
    deletedElements: elements.length - nonDeleted.length,
    elementTypeCounts,
    shapeElementCount,
    linearElementCount,
    imageElementCount,
    frameCount,
    textElementCount,
    editableGeometryCount: shapeElementCount + linearElementCount,
    duplicateIds: [...duplicates],
    invisiblySmallElementIds: invisibleIds,
    missingFileIds,
    orphanedFileIds,
    bindingIssues,
    frameIssues,
    qualityWarnings: quality.warnings,
    qualityFindings: quality.findings,
    qualityMetrics: quality.metrics,
    bounds,
  };
};

const isShapeElement = (element: GenericRecord): boolean => {
  return ["rectangle", "ellipse", "diamond"].includes(element.type) && !isAuxiliaryLayoutElement(element);
};

const moveElementCluster = (
  elements: GenericRecord[],
  rootId: string,
  deltaX: number,
  deltaY: number,
): boolean => {
  if (deltaX === 0 && deltaY === 0) {
    return false;
  }
  const elementMap = getElementMap(elements);
  const root = elementMap.get(rootId);
  if (!root) {
    return false;
  }
  const moved = new Set<string>();
  const queue: string[] = [rootId];

  while (queue.length > 0) {
    const nextId = queue.shift();
    if (!nextId || moved.has(nextId)) {
      continue;
    }
    const element = elementMap.get(nextId);
    if (!element) {
      continue;
    }
    element.x += deltaX;
    element.y += deltaY;
    moved.add(nextId);

    const boundText = getBoundTextElement(element, elementMap);
    if (boundText && !moved.has(boundText.id)) {
      queue.push(boundText.id);
    }
  }

  return moved.size > 0;
};

const attachLinearBindings = (
  elements: GenericRecord[],
  linear: GenericRecord,
  fromId: string,
  toId: string,
): void => {
  linear.startBinding = { elementId: fromId, focus: 0, gap: 1 };
  linear.endBinding = { elementId: toId, focus: 0, gap: 1 };
  const elementMap = getElementMap(elements);
  const bind = (elementId: string) => {
    const target = elementMap.get(elementId);
    if (!target) {
      return;
    }
    const nextBoundElements = Array.isArray(target.boundElements) ? [...target.boundElements] : [];
    if (!nextBoundElements.some((reference: GenericRecord) => reference.id === linear.id)) {
      nextBoundElements.push({ id: linear.id, type: linear.type });
    }
    target.boundElements = nextBoundElements;
  };
  bind(fromId);
  bind(toId);
};

const applyPresetToElements = (elements: GenericRecord[], documentValue?: SceneSpec["document"]): void => {
  const documentSettings = mergeDocument(documentValue);
  const forceCleanPreset = documentSettings.preset === "clean-flowchart";
  const nodeDefaults = getPresetDefaults(documentValue, "node");
  const linearDefaults = getPresetDefaults(documentValue, "linear");
  const frameDefaults = getPresetDefaults(documentValue, "frame");
  const textDefaults = getPresetDefaults(documentValue, "text");

  for (const element of elements) {
    if (element.isDeleted) {
      continue;
    }
    if (element.type === "text") {
      element.fontFamily = forceCleanPreset ? textDefaults.fontFamily : (element.fontFamily ?? textDefaults.fontFamily);
      element.fontSize = forceCleanPreset ? textDefaults.fontSize : (element.fontSize ?? textDefaults.fontSize);
      element.strokeColor = forceCleanPreset ? textDefaults.strokeColor : (element.strokeColor ?? textDefaults.strokeColor);
      continue;
    }
    if (element.type === "frame" || element.type === "magicframe") {
      element.strokeColor = forceCleanPreset ? frameDefaults.strokeColor : (element.strokeColor ?? frameDefaults.strokeColor);
      element.backgroundColor = forceCleanPreset ? frameDefaults.backgroundColor : (element.backgroundColor ?? frameDefaults.backgroundColor);
      element.strokeWidth = forceCleanPreset ? frameDefaults.strokeWidth : (element.strokeWidth ?? frameDefaults.strokeWidth);
      element.roughness = forceCleanPreset ? frameDefaults.roughness : (element.roughness ?? frameDefaults.roughness);
      element.opacity = forceCleanPreset ? frameDefaults.opacity : (element.opacity ?? frameDefaults.opacity);
      continue;
    }
    if (element.type === "arrow" || element.type === "line") {
      element.strokeColor = forceCleanPreset ? linearDefaults.strokeColor : (element.strokeColor ?? linearDefaults.strokeColor);
      element.strokeWidth = forceCleanPreset ? linearDefaults.strokeWidth : (element.strokeWidth ?? linearDefaults.strokeWidth);
      element.roughness = forceCleanPreset ? linearDefaults.roughness : (element.roughness ?? linearDefaults.roughness);
      element.fontFamily = forceCleanPreset ? linearDefaults.fontFamily : (element.fontFamily ?? linearDefaults.fontFamily);
      element.fontSize = forceCleanPreset ? linearDefaults.fontSize : (element.fontSize ?? linearDefaults.fontSize);
      if (element.type === "arrow") {
        element.endArrowhead = forceCleanPreset
          ? (linearDefaults.endArrowhead ?? "triangle")
          : (element.endArrowhead ?? linearDefaults.endArrowhead ?? "triangle");
      }
      continue;
    }
    element.strokeColor = forceCleanPreset ? nodeDefaults.strokeColor : (element.strokeColor ?? nodeDefaults.strokeColor);
    element.backgroundColor = forceCleanPreset ? nodeDefaults.backgroundColor : (element.backgroundColor ?? nodeDefaults.backgroundColor);
    element.fillStyle = forceCleanPreset ? nodeDefaults.fillStyle : (element.fillStyle ?? nodeDefaults.fillStyle);
    element.strokeWidth = forceCleanPreset ? nodeDefaults.strokeWidth : (element.strokeWidth ?? nodeDefaults.strokeWidth);
    element.roughness = forceCleanPreset ? nodeDefaults.roughness : (element.roughness ?? nodeDefaults.roughness);
    element.roundness = forceCleanPreset ? nodeDefaults.roundness : (element.roundness ?? nodeDefaults.roundness);
  }
};

const getGridOrderedNodes = (nodes: GenericRecord[]): GenericRecord[] => {
  return [...nodes].sort((left, right) => {
    const leftRow = Number(left.customData?.row ?? left.row ?? 0);
    const rightRow = Number(right.customData?.row ?? right.row ?? 0);
    if (leftRow !== rightRow) {
      return leftRow - rightRow;
    }
    const leftColumn = Number(left.customData?.column ?? left.column ?? 0);
    const rightColumn = Number(right.customData?.column ?? right.column ?? 0);
    if (leftColumn !== rightColumn) {
      return leftColumn - rightColumn;
    }
    if (left.y !== right.y) {
      return left.y - right.y;
    }
    return left.x - right.x;
  });
};

const rebalanceFrameChildren = (elements: GenericRecord[], documentValue?: SceneSpec["document"]): string[] => {
  const documentSettings = mergeDocument(documentValue);
  const fixes: string[] = [];
  const frameElements = elements.filter((element) => element.type === "frame" || element.type === "magicframe");
  for (const frame of frameElements) {
    if (frame.customData?.role != "swimlane") {
      continue;
    }
    const children = getGridOrderedNodes(elements.filter((element) => (
      element.frameId === frame.id &&
      !element.isDeleted &&
      isShapeElement(element)
    )));
    if (children.length === 0) {
      continue;
    }

    const paddingX = 28;
    const paddingY = 38;
    const gapX = Math.max(36, Math.round(documentSettings.gapX * 0.42));
    const gapY = Math.max(32, Math.round(documentSettings.gapY * 0.38));
    let currentX = frame.x + paddingX;
    let currentY = frame.y + paddingY + documentSettings.laneHeaderHeight;
    let rowHeight = 0;
    const maxFrameWidth = Number.POSITIVE_INFINITY;

    for (const child of children) {
      const childWidth = Number(child.width ?? documentSettings.nodeWidth);
      const childHeight = Number(child.height ?? documentSettings.nodeHeight);
      if (currentX + childWidth > frame.x + maxFrameWidth) {
        currentX = frame.x + paddingX;
        currentY += rowHeight + gapY;
        rowHeight = 0;
      }
      const deltaX = currentX - child.x;
      const deltaY = currentY - child.y;
      if (moveElementCluster(elements, child.id, deltaX, deltaY)) {
        fixes.push(`reflow-frame:${frame.id}:${child.id}`);
      }
      child.customData = {
        ...(child.customData ?? {}),
        row: Math.round((currentY - frame.y) / Math.max(gapY, 1)),
        column: Math.round((currentX - frame.x) / Math.max(gapX, 1)),
      };
      currentX += childWidth + gapX;
      rowHeight = Math.max(rowHeight, childHeight);
    }

    const childRects = children.map((child) => getRectForElement(child));
    const bounds = childRects.reduce((accumulator, rect) => ({
      minX: Math.min(accumulator.minX, rect.minX),
      minY: Math.min(accumulator.minY, rect.minY),
      maxX: Math.max(accumulator.maxX, rect.maxX),
      maxY: Math.max(accumulator.maxY, rect.maxY),
    }), childRects[0]);

    frame.x = bounds.minX - paddingX;
    frame.y = bounds.minY - (paddingY + documentSettings.laneHeaderHeight);
    frame.width = (bounds.maxX - bounds.minX) + paddingX * 2;
    frame.height = (bounds.maxY - bounds.minY) + paddingY * 2 + documentSettings.laneHeaderHeight;
  }

  return fixes;
};

const refitFramesToChildren = (elements: GenericRecord[], documentValue?: SceneSpec["document"]): string[] => {
  const documentSettings = mergeDocument(documentValue);
  const fixes: string[] = [];
  const frameElements = elements.filter((element) => element.type === "frame" || element.type === "magicframe");

  for (const frame of frameElements) {
    const children = elements.filter((element) => (
      !element.isDeleted &&
      element.frameId === frame.id &&
      !["arrow", "line", "frame", "magicframe", "selection"].includes(element.type)
    ));
    if (children.length === 0) {
      continue;
    }

    const childRects = children.map((child) => getRectForElement(child));
    const bounds = childRects.reduce((accumulator, rect) => ({
      minX: Math.min(accumulator.minX, rect.minX),
      minY: Math.min(accumulator.minY, rect.minY),
      maxX: Math.max(accumulator.maxX, rect.maxX),
      maxY: Math.max(accumulator.maxY, rect.maxY),
    }), childRects[0]);

    const isSwimlane = frame.customData?.role === "swimlane";
    const paddingX = isSwimlane ? 28 : 10;
    const paddingBottom = isSwimlane ? 38 : 10;
    const paddingTop = isSwimlane ? 38 + documentSettings.laneHeaderHeight : 10;
    const nextX = bounds.minX - paddingX;
    const nextY = bounds.minY - paddingTop;
    const nextWidth = (bounds.maxX - bounds.minX) + paddingX * 2;
    const nextHeight = (bounds.maxY - bounds.minY) + paddingTop + paddingBottom;
    if (
      Math.abs(Number(frame.x ?? 0) - nextX) > 0.5 ||
      Math.abs(Number(frame.y ?? 0) - nextY) > 0.5 ||
      Math.abs(Number(frame.width ?? 0) - nextWidth) > 0.5 ||
      Math.abs(Number(frame.height ?? 0) - nextHeight) > 0.5
    ) {
      frame.x = nextX;
      frame.y = nextY;
      frame.width = nextWidth;
      frame.height = nextHeight;
      fixes.push(`refit-frame:${frame.id}`);
    }
  }

  return fixes;
};

const widenCrowdedContainers = (elements: GenericRecord[], findings: QualityFinding[]): string[] => {
  const fixes: string[] = [];
  const elementMap = getElementMap(elements);
  const crowdedContainerIds = new Set<string>();
  for (const finding of findings) {
    if (!["crowded-label", "label-overflow"].includes(finding.code)) {
      continue;
    }
    const targetId = finding.elements?.[0];
    if (targetId) {
      crowdedContainerIds.add(targetId);
    }
  }

  for (const containerId of crowdedContainerIds) {
    const container = elementMap.get(containerId);
    if (!container || !isShapeElement(container)) {
      continue;
    }
    const boundText = getBoundTextElement(container, elementMap);
    const textRect = boundText ? getRectForElement(boundText) : null;
    const currentWidth = Math.max(1, Number(container.width ?? 0));
    const currentHeight = Math.max(1, Number(container.height ?? 0));
    const currentTextWidth = textRect ? Math.max(1, textRect.maxX - textRect.minX) : currentWidth * 0.6;
    const currentTextHeight = textRect ? Math.max(1, textRect.maxY - textRect.minY) : currentHeight * 0.4;
    const { widthFactor, heightFactor } = getShapeTextInsets(container);
    const desiredWidth = Math.max(
      currentWidth + 24,
      Math.round(Math.max(currentTextWidth / 0.62 / widthFactor, currentTextWidth + 56)),
    );
    const desiredHeight = Math.max(
      currentHeight + 18,
      Math.round(Math.max(currentTextHeight / 0.56 / heightFactor, currentTextHeight + 40)),
    );
    const widthGrowth = desiredWidth - currentWidth;
    const heightGrowth = desiredHeight - currentHeight;
    if (widthGrowth <= 0 && heightGrowth <= 0) {
      continue;
    }
    container.x -= Math.round(widthGrowth / 2);
    container.y -= Math.round(heightGrowth / 2);
    container.width = desiredWidth;
    container.height = desiredHeight;
    fixes.push(`widen-container:${containerId}`);
  }

  return fixes;
};

const fixOverlappingShapes = (elements: GenericRecord[], findings: QualityFinding[]): string[] => {
  const fixes: string[] = [];
  const elementMap = getElementMap(elements);
  for (const finding of findings) {
    if (finding.code !== "node-overlap" || (finding.elements?.length ?? 0) < 2) {
      continue;
    }
    const first = elementMap.get(finding.elements![0]);
    const second = elementMap.get(finding.elements![1]);
    if (!first || !second || !isShapeElement(first) || !isShapeElement(second)) {
      continue;
    }
    const rectA = getRectForElement(first);
    const rectB = getRectForElement(second);
    const overlapX = Math.min(rectA.maxX, rectB.maxX) - Math.max(rectA.minX, rectB.minX);
    const overlapY = Math.min(rectA.maxY, rectB.maxY) - Math.max(rectA.minY, rectB.minY);
    if (overlapX <= 0 || overlapY <= 0) {
      continue;
    }

    const gap = 32;
    const deltaX = overlapX <= overlapY ? overlapX + gap : 0;
    const deltaY = overlapY < overlapX ? overlapY + gap : 0;
    const directionX = rectB.minX >= rectA.minX ? 1 : -1;
    const directionY = rectB.minY >= rectA.minY ? 1 : -1;
    if (moveElementCluster(elements, second.id, deltaX * directionX, deltaY * directionY)) {
      fixes.push(`nudge-overlap:${second.id}`);
    }
  }
  return fixes;
};

const countRouteCrossings = (
  candidatePoints: Point[],
  linearId: string,
  fromId: string | undefined,
  toId: string | undefined,
  elements: GenericRecord[],
): number => {
  const blockers = elements.filter((element) => (
    !element.isDeleted &&
    !["arrow", "line", "frame", "magicframe", "selection"].includes(element.type) &&
    !isAuxiliaryLayoutElement(element) &&
    element.id !== fromId &&
    element.id !== toId &&
    element.containerId !== fromId &&
    element.containerId !== toId
  ));
  const otherLinears = elements.filter((element) => (
    !element.isDeleted &&
    (element.type === "arrow" || element.type === "line") &&
    element.id !== linearId
  ));

  let score = 0;
  for (let index = 0; index < candidatePoints.length - 1; index += 1) {
    const start = candidatePoints[index];
    const end = candidatePoints[index + 1];
    for (const blocker of blockers) {
      const rect = expandRect(getRectForElement(blocker), blocker.type === "text" ? 6 : 10);
      if (segmentIntersectsRect(start, end, rect)) {
        score += 3;
      }
    }
    for (const other of otherLinears) {
      const otherPoints = getPolylinePoints(other);
      for (let otherIndex = 0; otherIndex < otherPoints.length - 1; otherIndex += 1) {
        const otherStart = otherPoints[otherIndex];
        const otherEnd = otherPoints[otherIndex + 1];
        if (
          sharesEndpoint(start, otherStart) ||
          sharesEndpoint(start, otherEnd) ||
          sharesEndpoint(end, otherStart) ||
          sharesEndpoint(end, otherEnd)
        ) {
          continue;
        }
        if (segmentsIntersect(start, end, otherStart, otherEnd)) {
          score += 1;
        }
      }
    }
  }
  return score;
};

const compactPolyline = (points: Point[]): Point[] => {
  const compacted: Point[] = [];
  for (const point of points) {
    const previous = compacted[compacted.length - 1];
    if (previous && sharesEndpoint(previous, point, 0.5)) {
      continue;
    }
    compacted.push(point);
  }
  return compacted.length >= 2 ? compacted : points;
};

const getInlineGap = (fromRect: Rect, toRect: Rect, start: Point, end: Point): number => {
  if (Math.abs(start.y - end.y) <= 24) {
    if (fromRect.maxX <= toRect.minX) {
      return toRect.minX - fromRect.maxX;
    }
    if (toRect.maxX <= fromRect.minX) {
      return fromRect.minX - toRect.maxX;
    }
  }
  if (Math.abs(start.x - end.x) <= 24) {
    if (fromRect.maxY <= toRect.minY) {
      return toRect.minY - fromRect.maxY;
    }
    if (toRect.maxY <= fromRect.minY) {
      return fromRect.minY - toRect.maxY;
    }
  }
  return 0;
};

const shouldPreferStraightRoute = (
  start: Point,
  end: Point,
  fromRect: Rect,
  toRect: Rect,
  labelWidth: number,
  labelHeight: number,
  linear: GenericRecord,
  fromId: string,
  toId: string,
  elements: GenericRecord[],
): boolean => {
  const horizontallyAligned = Math.abs(start.y - end.y) <= 24;
  const verticallyAligned = Math.abs(start.x - end.x) <= 24;
  if (!horizontallyAligned && !verticallyAligned) {
    return false;
  }

  const gap = getInlineGap(fromRect, toRect, start, end);
  if (gap <= 0) {
    return false;
  }
  const requiredGap = (horizontallyAligned ? labelWidth : labelHeight) + 24;
  if (requiredGap > 0 && gap < requiredGap) {
    return false;
  }

  const straightCandidate = compactPolyline([start, end]);
  if (countRouteCrossings(straightCandidate, linear.id, fromId, toId, elements) > 0) {
    return false;
  }

  return true;
};

const scoreRouteCandidate = (
  candidatePoints: Point[],
  linear: GenericRecord,
  elementMap: Map<string, GenericRecord>,
  fromId: string | undefined,
  toId: string | undefined,
  elements: GenericRecord[],
): number => {
  let score = countRouteCrossings(candidatePoints, linear.id, fromId, toId, elements) * 6;
  const start = candidatePoints[0];
  const end = candidatePoints[candidatePoints.length - 1];
  const fromElement = fromId ? elementMap.get(fromId) : null;
  const toElement = toId ? elementMap.get(toId) : null;
  if (fromElement) {
    const fromRect = expandRect(getRectForElement(fromElement), 24);
    if (!pointInRect(start, fromRect) && !(
      start.x >= fromRect.minX &&
      start.x <= fromRect.maxX &&
      start.y >= fromRect.minY &&
      start.y <= fromRect.maxY
    )) {
      score += 80;
    }
  }
  if (toElement) {
    const toRect = expandRect(getRectForElement(toElement), 24);
    if (!pointInRect(end, toRect) && !(
      end.x >= toRect.minX &&
      end.x <= toRect.maxX &&
      end.y >= toRect.minY &&
      end.y <= toRect.maxY
    )) {
      score += 80;
    }
  }
  const labelRect = getLinearLabelBox(linear, elementMap, candidatePoints);
  if (labelRect) {
    const blockers = elements.filter((element) => (
      !element.isDeleted &&
      !["arrow", "line", "frame", "magicframe", "selection"].includes(element.type) &&
      !isAuxiliaryLayoutElement(element) &&
      element.containerId !== linear.id
    ));
    for (const blocker of blockers) {
      const blockerRect = getRectForElement(blocker);
      if (rectsOverlap(labelRect, blockerRect, 0)) {
        score += blocker.id === fromId || blocker.id === toId ? 60 : 36;
      }
    }
  }

  return score + (getPolylineLength(candidatePoints) / 1000);
};

const rerouteLinearElements = (elements: GenericRecord[]): string[] => {
  return rerouteLinearElementsWithHistory(elements, new Map());
};

const rerouteLinearElementsWithHistory = (
  elements: GenericRecord[],
  routeHistory: Map<string, RouteHistoryEntry>,
): string[] => {
  const fixes: string[] = [];
  const elementMap = getElementMap(elements);
  const linears = elements.filter((element) => (
    !element.isDeleted &&
    (element.type === "arrow" || element.type === "line") &&
    !isAuxiliaryLayoutElement(element)
  ));

  for (const linear of linears) {
    const fromId = linear.customData?.fromId ?? linear.startBinding?.elementId;
    const toId = linear.customData?.toId ?? linear.endBinding?.elementId;
    if (!fromId || !toId) {
      continue;
    }
    const fromElement = elementMap.get(fromId);
    const toElement = elementMap.get(toId);
    if (!fromElement || !toElement) {
      continue;
    }

    const regeneratedEdge = convertToExcalidrawElements([
      buildEdgeSkeleton({
        id: linear.id,
        type: linear.type === "line" ? "line" : "arrow",
        from: fromId,
        to: toId,
        label: linear.label?.text ?? linear.customData?.label,
        style: {
          strokeColor: linear.strokeColor,
          strokeWidth: linear.strokeWidth,
          strokeStyle: linear.strokeStyle,
          roughness: linear.roughness,
          opacity: linear.opacity,
          startArrowhead: linear.startArrowhead,
          endArrowhead: linear.endArrowhead,
          fontFamily: linear.fontFamily,
          fontSize: linear.fontSize,
        },
        customData: linear.customData,
      }, elementMap),
    ] as any, { regenerateIds: false }) as GenericRecord[];
    const freshLinear = regeneratedEdge[0];
    const freshPoints = getPolylinePoints(freshLinear);
    const currentPoints = getPolylinePoints(linear);
    const start = freshPoints[0];
    const currentEnd = freshPoints[freshPoints.length - 1];
    const horizontalMidX = Math.round((start.x + currentEnd.x) / 2);
    const verticalMidY = Math.round((start.y + currentEnd.y) / 2);
    const labelRect = getLinearLabelBox(linear, elementMap, [start, currentEnd]);
    const labelWidth = labelRect ? (labelRect.maxX - labelRect.minX) : 0;
    const labelHeight = labelRect ? (labelRect.maxY - labelRect.minY) : 0;
    const fromRect = getRectForElement(fromElement);
    const toRect = getRectForElement(toElement);
    const topY = Math.round(Math.min(fromRect.minY, toRect.minY) - (labelHeight / 2 + 18));
    const bottomY = Math.round(Math.max(fromRect.maxY, toRect.maxY) + (labelHeight / 2 + 18));
    const leftX = Math.round(Math.min(fromRect.minX, toRect.minX) - (labelWidth / 2 + 18));
    const rightX = Math.round(Math.max(fromRect.maxX, toRect.maxX) + (labelWidth / 2 + 18));
    const candidates: Point[][] = [
      [start, currentEnd],
      [start, { x: horizontalMidX, y: start.y }, { x: horizontalMidX, y: currentEnd.y }, currentEnd],
      [start, { x: start.x, y: verticalMidY }, { x: currentEnd.x, y: verticalMidY }, currentEnd],
      [start, { x: start.x, y: topY }, { x: currentEnd.x, y: topY }, currentEnd],
      [start, { x: start.x, y: bottomY }, { x: currentEnd.x, y: bottomY }, currentEnd],
      [start, { x: leftX, y: start.y }, { x: leftX, y: currentEnd.y }, currentEnd],
      [start, { x: rightX, y: start.y }, { x: rightX, y: currentEnd.y }, currentEnd],
    ];

    let bestCandidate = candidates[0];
    let bestScore = Number.POSITIVE_INFINITY;
    const currentScore = scoreRouteCandidate(currentPoints, linear, elementMap, fromId, toId, elements);
    const currentSignature = JSON.stringify({
      x: linear.x,
      y: linear.y,
      points: Array.isArray(linear.points) ? linear.points : [],
    });
    const historyEntry = routeHistory.get(linear.id) ?? {
      bestScore: currentScore,
      attemptedSignatures: new Set<string>([currentSignature]),
    };

    if (shouldPreferStraightRoute(start, currentEnd, fromRect, toRect, labelWidth, labelHeight, linear, fromId, toId, elements)) {
      bestCandidate = compactPolyline([start, currentEnd]);
      bestScore = scoreRouteCandidate(bestCandidate, linear, elementMap, fromId, toId, elements) - 1;
    }

    for (const candidate of candidates) {
      const compactedCandidate = compactPolyline(candidate);
      const score = scoreRouteCandidate(compactedCandidate, linear, elementMap, fromId, toId, elements);
      if (score < bestScore) {
        bestScore = score;
        bestCandidate = compactedCandidate;
      }
    }
    if (bestScore + 0.25 >= currentScore) {
      historyEntry.bestScore = Math.min(historyEntry.bestScore, currentScore);
      routeHistory.set(linear.id, historyEntry);
      continue;
    }

    const nextPoints = bestCandidate.map((point) => [point.x - bestCandidate[0].x, point.y - bestCandidate[0].y]);
    const nextSignature = JSON.stringify({
      x: bestCandidate[0].x,
      y: bestCandidate[0].y,
      points: nextPoints,
    });
    if (currentSignature === nextSignature) {
      historyEntry.bestScore = Math.min(historyEntry.bestScore, currentScore);
      routeHistory.set(linear.id, historyEntry);
      continue;
    }
    if (historyEntry.attemptedSignatures.has(nextSignature)) {
      historyEntry.bestScore = Math.min(historyEntry.bestScore, currentScore);
      routeHistory.set(linear.id, historyEntry);
      continue;
    }

    linear.x = bestCandidate[0].x;
    linear.y = bestCandidate[0].y;
    linear.points = nextPoints;
    attachLinearBindings(elements, linear, fromId, toId);
    historyEntry.bestScore = Math.min(historyEntry.bestScore, bestScore);
    historyEntry.attemptedSignatures.add(currentSignature);
    historyEntry.attemptedSignatures.add(nextSignature);
    routeHistory.set(linear.id, historyEntry);
    fixes.push(`reroute-edge:${linear.id}`);
  }

  return fixes;
};

export const autoRepairElements = (
  elementsInput: GenericRecord[],
  files: GenericRecord,
  inputKind: string,
  documentValue?: SceneSpec["document"],
): { elements: GenericRecord[]; report: GenericRecord; autoFixes: string[] } => {
  let elements = cloneValue(elementsInput);
  const autoFixes: string[] = [];
  const routeHistory = new Map<string, RouteHistoryEntry>();

  applyPresetToElements(elements, documentValue);

  for (let pass = 0; pass < MAX_AUTO_REPAIR_PASSES; pass += 1) {
    elements = restoreElements(elements as any, null, {
      refreshDimensions: true,
      repairBindings: true,
    }) as GenericRecord[];
    applyPresetToElements(elements, documentValue);

    const inspect = inspectSceneData(elements, files, inputKind);
    const findings = Array.isArray(inspect.qualityFindings) ? inspect.qualityFindings as QualityFinding[] : [];
    const shouldReroute = findings.some((finding) => ROUTE_RELATED_FINDING_CODES.has(finding.code));
    const passFixes = [
      ...widenCrowdedContainers(elements, findings),
      ...fixOverlappingShapes(elements, findings),
      ...rebalanceFrameChildren(elements, documentValue),
      ...refitFramesToChildren(elements, documentValue),
      ...(shouldReroute ? rerouteLinearElementsWithHistory(elements, routeHistory) : []),
    ];
    if (passFixes.length === 0) {
      break;
    }
    autoFixes.push(...passFixes);
  }

  elements = restoreElements(elements as any, null, {
    refreshDimensions: true,
    repairBindings: true,
  }) as GenericRecord[];
  applyPresetToElements(elements, documentValue);
  const finalInspect = inspectSceneData(elements, files, inputKind);
  const finalFindings = Array.isArray(finalInspect.qualityFindings) ? finalInspect.qualityFindings as QualityFinding[] : [];
  autoFixes.push(...refitFramesToChildren(elements, documentValue));
  if (finalFindings.some((finding) => ROUTE_RELATED_FINDING_CODES.has(finding.code))) {
    autoFixes.push(...rerouteLinearElementsWithHistory(elements, routeHistory));
  }

  return {
    elements,
    report: inspectSceneData(elements, files, inputKind),
    autoFixes,
  };
};

const layoutNodesOnGrid = (
  nodes: SceneSpec["nodes"],
  documentValue?: SceneSpec["document"],
): NonNullable<SceneSpec["nodes"]> => {
  const documentSettings = mergeDocument(documentValue);
  const rows = new Map<number, SceneSpec["nodes"]>();
  const normalized = (nodes ?? []).map((node) => ({
    ...node,
    row: Number(node.row ?? 0),
    column: Number(node.column ?? 0),
  }));
  for (const node of normalized) {
    const row = Number(node.row ?? 0);
    const current = rows.get(row) ?? [];
    current.push(node);
    rows.set(row, current);
  }
  const laidOut: NonNullable<SceneSpec["nodes"]> = [];
  const sortedRows = [...rows.keys()].sort((left, right) => left - right);
  let currentY = documentSettings.padding;
  for (const rowIndex of sortedRows) {
    const rowNodes = [...(rows.get(rowIndex) ?? [])].sort((left, right) => Number(left.column ?? 0) - Number(right.column ?? 0));
    let currentX = documentSettings.padding;
    let rowHeight = 0;
    for (const rowNode of layoutNodes(rowNodes, { ...documentSettings, layout: "manual" })) {
      const positionedNode = {
        ...rowNode,
        x: typeof rowNode.x === "number" ? currentX : currentX,
        y: typeof rowNode.y === "number" ? currentY : currentY,
      };
      currentX += Number(positionedNode.width ?? documentSettings.nodeWidth) + documentSettings.gapX;
      rowHeight = Math.max(rowHeight, Number(positionedNode.height ?? documentSettings.nodeHeight));
      laidOut.push(positionedNode);
    }
    currentY += rowHeight + documentSettings.gapY;
  }
  return laidOut;
};

const layoutSwimlanes = (
  nodes: SceneSpec["nodes"],
  swimlanes: SceneSwimlaneSpec[],
  documentValue?: SceneSpec["document"],
): { nodes: SceneSpec["nodes"]; frames: SceneFrameSpec[] } => {
  const documentSettings = mergeDocument(documentValue);
  const laneNodeIds = new Set<string>();
  const positioned: NonNullable<SceneSpec["nodes"]> = [];
  const frames: SceneFrameSpec[] = [];
  let currentY = documentSettings.padding;

  for (const lane of swimlanes) {
    const laneNodes = (nodes ?? []).filter((node) => (
      (lane.children ?? []).includes(node.id) || node.lane === lane.id
    ));
    laneNodes.forEach((node) => laneNodeIds.add(node.id));
    const rowedNodes: NonNullable<SceneSpec["nodes"]> = laneNodes.some((node) => node.row !== undefined || node.column !== undefined)
      ? layoutNodesOnGrid(laneNodes, { ...documentSettings, layout: "manual" })
      : layoutNodes(laneNodes, { ...documentSettings, layout: "flow-right", wrapAt: Math.max(documentSettings.wrapAt, laneNodes.length) });
    let laneHeight = documentSettings.nodeHeight;
    const laneBaseX = lane.x ?? documentSettings.padding;
    const laneBaseY = lane.y ?? currentY;
    const lanePositioned: NonNullable<SceneSpec["nodes"]> = rowedNodes.map((node) => {
      const next = {
        ...node,
        x: laneBaseX + 32 + (Number(node.x ?? documentSettings.padding) - documentSettings.padding),
        y: laneBaseY + documentSettings.laneHeaderHeight + 28 + (Number(node.y ?? documentSettings.padding) - documentSettings.padding),
      };
      laneHeight = Math.max(laneHeight, Number(next.height ?? documentSettings.nodeHeight));
      next.customData = {
        ...(next.customData ?? {}),
        lane: lane.id,
      };
      return next;
    });
    positioned.push(...lanePositioned);
    frames.push({
      id: lane.id,
      name: lane.label,
      children: lanePositioned.map((node) => node.id),
      style: lane.style,
      customData: {
        ...(lane.customData ?? {}),
        role: "swimlane",
      },
    });
    const laneBottom = lanePositioned.reduce((maximum, node) => (
      Math.max(maximum, Number(node.y ?? currentY) + Number(node.height ?? documentSettings.nodeHeight))
    ), currentY + documentSettings.nodeHeight + documentSettings.laneHeaderHeight);
    currentY = laneBottom + documentSettings.laneGap;
  }

  const unassignedNodes = (nodes ?? []).filter((node) => !laneNodeIds.has(node.id));
  if (unassignedNodes.length > 0) {
    const remaining = layoutNodes(unassignedNodes, {
      ...documentSettings,
      layout: documentSettings.layout === "manual" ? "flow-right" : documentSettings.layout,
    });
    const verticalOffset = swimlanes.length > 0 ? currentY : 0;
    positioned.push(...remaining.map((node) => ({
      ...node,
      y: Number(node.y ?? documentSettings.padding) + verticalOffset,
    })));
  }

  return { nodes: positioned, frames };
};

const addCalloutsToScene = (
  nodes: NonNullable<SceneSpec["nodes"]>,
  edges: SceneEdgeSpec[],
  callouts: SceneCalloutSpec[],
  documentValue?: SceneSpec["document"],
): { nodes: NonNullable<SceneSpec["nodes"]>; edges: SceneEdgeSpec[] } => {
  const documentSettings = mergeDocument(documentValue);
  const nextNodes = [...nodes];
  const nextEdges = [...edges];
  const nodeMap = new Map(nextNodes.map((node) => [node.id, node]));
  const placementOffsets: Record<string, Point> = {
    right: { x: documentSettings.calloutGap + 120, y: 0 },
    left: { x: -(documentSettings.calloutGap + 220), y: 0 },
    top: { x: 0, y: -(documentSettings.calloutGap + 100) },
    bottom: { x: 0, y: documentSettings.calloutGap + 100 },
  };

  for (const callout of callouts) {
    const target = nodeMap.get(callout.target);
    if (!target) {
      continue;
    }
    const placement = callout.placement ?? "right";
    const offset = placementOffsets[placement];
    const calloutNode: NonNullable<SceneSpec["nodes"]>[number] = {
      id: callout.id,
      role: "callout",
      kind: "rectangle",
      label: callout.label,
      x: Number(target.x ?? documentSettings.padding) + offset.x,
      y: Number(target.y ?? documentSettings.padding) + offset.y,
      width: callout.width ?? 240,
      height: callout.height ?? 88,
      style: {
        fillStyle: "solid",
        backgroundColor: "#f8fbff",
        strokeColor: "#6d8ba7",
        strokeStyle: "dashed",
        strokeWidth: 1,
        roughness: 0,
        ...(callout.style ?? {}),
      },
      customData: {
        ...(callout.customData ?? {}),
        role: "callout",
      },
    };
    nextNodes.push(calloutNode);
    nextEdges.push({
      id: `${callout.id}-connector`,
      type: "line",
      from: callout.target,
      to: callout.id,
      style: {
        strokeStyle: "dashed",
        roughness: 0,
        strokeWidth: 1,
      },
      customData: {
        role: "callout-connector",
      },
    });
    nodeMap.set(callout.id, calloutNode);
  }

  return { nodes: nextNodes, edges: nextEdges };
};

const expandSpacingForLabeledEdges = (
  nodes: NonNullable<SceneSpec["nodes"]>,
  edges: SceneEdgeSpec[],
  documentValue?: SceneSpec["document"],
): NonNullable<SceneSpec["nodes"]> => {
  const documentSettings = mergeDocument(documentValue);
  const linearDefaults = getPresetDefaults(documentSettings, "linear");
  const fontSize = Number(linearDefaults.fontSize ?? 16);
  const adjusted = nodes.map((node) => ({ ...node }));
  const adjustedMap = new Map(adjusted.map((node) => [node.id, node]));

  const shiftNodes = (
    predicate: (node: NonNullable<SceneSpec["nodes"]>[number]) => boolean,
    axis: "x" | "y",
    delta: number,
  ) => {
    if (delta <= 0) {
      return;
    }
    for (const node of adjusted) {
      if (!predicate(node)) {
        continue;
      }
      node[axis] = Number(node[axis] ?? documentSettings.padding) + delta;
    }
  };

  for (const edge of edges) {
    if (!edge.label || edge.customData?.role === "callout-connector") {
      continue;
    }
    const fromNode = adjustedMap.get(edge.from);
    const toNode = adjustedMap.get(edge.to);
    if (!fromNode || !toNode) {
      continue;
    }

    const fromX = Number(fromNode.x ?? documentSettings.padding);
    const fromY = Number(fromNode.y ?? documentSettings.padding);
    const toX = Number(toNode.x ?? documentSettings.padding);
    const toY = Number(toNode.y ?? documentSettings.padding);
    const fromWidth = Number(fromNode.width ?? documentSettings.nodeWidth);
    const fromHeight = Number(fromNode.height ?? documentSettings.nodeHeight);
    const toWidth = Number(toNode.width ?? documentSettings.nodeWidth);
    const toHeight = Number(toNode.height ?? documentSettings.nodeHeight);
    const fromCenterY = fromY + fromHeight / 2;
    const toCenterY = toY + toHeight / 2;
    const fromCenterX = fromX + fromWidth / 2;
    const toCenterX = toX + toWidth / 2;
    const labelSize = measureTextBox(edge.label, fontSize);
    const sameLane = (fromNode.lane ?? fromNode.customData?.lane ?? null) === (toNode.lane ?? toNode.customData?.lane ?? null);

    if (sameLane && Math.abs(fromCenterY - toCenterY) <= Math.max(fromHeight, toHeight) * 0.45) {
      const leftNode = fromX <= toX ? fromNode : toNode;
      const rightNode = leftNode.id === fromNode.id ? toNode : fromNode;
      const leftX = Number(leftNode.x ?? documentSettings.padding);
      const rightX = Number(rightNode.x ?? documentSettings.padding);
      const leftWidth = Number(leftNode.width ?? documentSettings.nodeWidth);
      const currentGap = rightX - (leftX + leftWidth);
      const requiredGap = Math.max(Math.round(labelSize.width + 28), Math.round(documentSettings.gapX * 0.8));
      if (currentGap < requiredGap) {
        const laneId = rightNode.lane ?? rightNode.customData?.lane;
        shiftNodes(
          (node) => (
            (node.lane ?? node.customData?.lane ?? null) === (laneId ?? null) &&
            Number(node.x ?? documentSettings.padding) >= rightX
          ),
          "x",
          requiredGap - currentGap,
        );
      }
      continue;
    }

    if (sameLane && Math.abs(fromCenterX - toCenterX) <= Math.max(fromWidth, toWidth) * 0.45) {
      const upperNode = fromY <= toY ? fromNode : toNode;
      const lowerNode = upperNode.id === fromNode.id ? toNode : fromNode;
      const upperY = Number(upperNode.y ?? documentSettings.padding);
      const lowerY = Number(lowerNode.y ?? documentSettings.padding);
      const upperHeight = Number(upperNode.height ?? documentSettings.nodeHeight);
      const currentGap = lowerY - (upperY + upperHeight);
      const requiredGap = Math.max(Math.round(labelSize.height + 24), Math.round(documentSettings.gapY * 0.55));
      if (currentGap < requiredGap) {
        const laneId = lowerNode.lane ?? lowerNode.customData?.lane;
        shiftNodes(
          (node) => (
            (node.lane ?? node.customData?.lane ?? null) === (laneId ?? null) &&
            Number(node.y ?? documentSettings.padding) >= lowerY
          ),
          "y",
          requiredGap - currentGap,
        );
      }
    }
  }

  return adjusted;
};

const expandSceneSpec = async (spec: SceneSpec): Promise<{
  nodes: NonNullable<SceneSpec["nodes"]>;
  edges: SceneEdgeSpec[];
  frames: SceneFrameSpec[];
  report: GenericRecord;
}> => {
  const documentSettings = mergeDocument(spec.document);
  const nodes: NonNullable<SceneSpec["nodes"]> = cloneValue(spec.nodes ?? []);
  const edges: SceneEdgeSpec[] = cloneValue(spec.edges ?? []);
  const frames: SceneFrameSpec[] = cloneValue(spec.frames ?? []);
  const swimlanes = cloneValue(spec.swimlanes ?? []);
  const outcomeRows = cloneValue(spec.outcomeRows ?? []);
  const callouts = cloneValue(spec.callouts ?? []);

  assignOutcomeRowsToNodes(nodes, outcomeRows);

  const usesRichFlowchartPrimitives = swimlanes.length > 0 || outcomeRows.length > 0 || callouts.length > 0;
  const resolvedDocument = usesRichFlowchartPrimitives && !spec.document?.preset
    ? { ...documentSettings, preset: "clean-flowchart" as const }
    : documentSettings;
  if (resolvedDocument.preset === "clean-flowchart") {
    resolvedDocument.gapX = Math.max(resolvedDocument.gapX, usesRichFlowchartPrimitives ? 180 : 140);
    resolvedDocument.gapY = Math.max(resolvedDocument.gapY, usesRichFlowchartPrimitives ? 96 : 84);
    resolvedDocument.laneGap = Math.max(resolvedDocument.laneGap, 96);
  }

  const layoutGraph = buildLayoutGraph({
    nodes,
    edges,
    frames,
    swimlanes,
    callouts,
    document: resolvedDocument,
    usesRichFlowchartPrimitives,
  });
  const selectedLayout = selectLayoutEngine(layoutGraph);
  const laidOut: {
    nodes: NonNullable<SceneSpec["nodes"]>;
    edges: SceneEdgeSpec[];
    frames: SceneFrameSpec[];
    report: GenericRecord;
  } = selectedLayout.engine === "elk"
    ? await layoutGraphWithElk(layoutGraph)
    : (swimlanes.length > 0
        ? (() => {
            const legacySwimlanes = layoutSwimlanes(nodes, swimlanes, resolvedDocument);
            return {
              nodes: legacySwimlanes.nodes ?? [],
              frames: legacySwimlanes.frames,
              edges,
              report: {
                layoutEngine: "legacy",
                usedSwimlaneBands: false,
              },
            };
          })()
        : {
            nodes: nodes.some((node) => node.row !== undefined || node.column !== undefined)
              ? layoutNodesOnGrid(nodes, resolvedDocument)
              : layoutNodes(nodes, resolvedDocument),
            edges,
            frames,
            report: {
              layoutEngine: "legacy",
              usedSwimlaneBands: false,
            },
          });

  const spacedNodes = expandSpacingForLabeledEdges(laidOut.nodes ?? [], laidOut.edges ?? edges, resolvedDocument);
  const withCallouts = addCalloutsToScene(
    spacedNodes,
    edges,
    callouts,
    resolvedDocument,
  );
  const expandedFrames = laidOut.frames;

  return {
    nodes: withCallouts.nodes,
    edges: laidOut.edges.map((edge: SceneEdgeSpec) => {
      const calloutEdge = withCallouts.edges.find((candidate) => candidate.id === edge.id);
      return calloutEdge ?? edge;
    }).concat(withCallouts.edges.filter((edge) => !laidOut.edges.some((candidate) => candidate.id === edge.id))),
    frames: expandedFrames,
    report: {
      usesRichFlowchartPrimitives,
      swimlaneCount: swimlanes.length,
      outcomeRowCount: outcomeRows.length,
      calloutCount: callouts.length,
      preset: resolvedDocument.preset,
      document: resolvedDocument,
      layoutEngine: selectedLayout.engine,
      layoutEngineReason: selectedLayout.reason,
      layoutDetail: laidOut.report ?? {},
    },
  };
};

const convertEdgeAgainstExisting = (
  elements: GenericRecord[],
  edge: SceneEdgeSpec,
  documentValue?: SceneSpec["document"],
): GenericRecord[] => {
  const elementMap = getElementMap(elements);
  if (!elementMap.get(edge.from) || !elementMap.get(edge.to)) {
    throw new Error(`Could not connect ${edge.from} -> ${edge.to}: missing endpoint`);
  }

  return convertToExcalidrawElements([buildEdgeSkeleton(edge, elementMap, documentValue)] as any, {
    regenerateIds: false,
  }) as GenericRecord[];
};

const createFrameAgainstExisting = (
  elements: GenericRecord[],
  frame: SceneFrameSpec,
  documentValue?: SceneSpec["document"],
): GenericRecord => {
  const elementMap = getElementMap(elements);
  const helperSkeletons = (frame.children ?? [])
    .map((childId) => {
      const child = elementMap.get(childId);
      if (!child) {
        throw new Error(`Could not create frame ${frame.id ?? frame.name ?? "frame"}: missing child ${childId}`);
      }
      return elementToHelperSkeleton(child, elementMap);
    })
    .filter(Boolean) as GenericRecord[];
  helperSkeletons.push(buildFrameSkeleton(frame, documentValue));
  const converted = convertToExcalidrawElements(helperSkeletons as any, { regenerateIds: false }) as GenericRecord[];
  const createdFrame = converted.find((element) => element.id === frame.id);
  if (!createdFrame) {
    throw new Error(`Could not create frame ${frame.id}`);
  }
  return createdFrame;
};

export const createSceneFromSpec = async (spec: SceneSpec) => {
  const expanded = await expandSceneSpec(spec);
  const nodes = expanded.nodes;
  const edges = expanded.edges;
  const frames = expanded.frames;
  const documentSettings = expanded.report.document as SceneSpec["document"];

  const allIds = [...nodes.map((node) => node.id), ...edges.map((edge) => edge.id), ...frames.map((frame) => frame.id)]
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  const duplicateSpecIds = getRawDuplicateIds(allIds.map((id) => ({ id })));
  if (duplicateSpecIds.length > 0) {
    throw new Error(`Scene spec contains duplicate IDs: ${duplicateSpecIds.join(", ")}`);
  }

  const laidOutNodes = nodes;
  const edgeLookup = new Map(laidOutNodes.map((node) => [node.id, buildNodeSkeleton(node, documentSettings)]));
  const skeletons = [
    ...laidOutNodes.map((node) => buildNodeSkeleton(node, documentSettings)),
    ...edges.map((edge) => buildEdgeSkeleton(edge, edgeLookup, documentSettings)),
  ];
  let converted = convertToExcalidrawElements(skeletons as any, { regenerateIds: false }) as GenericRecord[];
  for (const frame of frames) {
    const frameId = frame.id ?? `frame-${crypto.randomUUID()}`;
    const createdFrame = createFrameAgainstExisting(converted, { ...frame, id: frameId }, documentSettings);
    converted = converted.concat(createdFrame);
    converted = converted.map((element) => (
      (frame.children ?? []).includes(element.id) ? { ...element, frameId } : element
    ));
  }
  const appState = buildAppState(documentSettings);
  const repaired = autoRepairElements(converted, {}, "scene", documentSettings);
  return {
    sceneText: serializeScene(repaired.elements, appState, {}),
    report: {
      nodeCount: laidOutNodes.length,
      edgeCount: edges.length,
      frameCount: frames.length,
      layout: (documentSettings?.layout ?? "flow-right"),
      preset: documentSettings?.preset ?? "default",
      autoFixes: repaired.autoFixes,
      qualityWarnings: repaired.report.qualityWarnings ?? [],
      usesRichFlowchartPrimitives: expanded.report.usesRichFlowchartPrimitives,
      swimlaneCount: expanded.report.swimlaneCount,
      outcomeRowCount: expanded.report.outcomeRowCount,
      calloutCount: expanded.report.calloutCount,
      layoutEngine: expanded.report.layoutEngine,
      layoutEngineReason: expanded.report.layoutEngineReason,
      layoutDetail: expanded.report.layoutDetail,
    },
  };
};

export const applyPatchOperations = (
  sceneText: string,
  patch: PatchSpec,
): { sceneText: string; report: GenericRecord } => {
  const parsed = parseSceneLikeText(sceneText);
  let elements = cloneValue(parsed.elements);
  const files = cloneValue(parsed.files);
  let textChanged = false;
  const applied: string[] = [];

  for (const operation of patch.operations ?? []) {
    const elementMap = getElementMap(elements);
    switch (operation.op) {
      case "rename": {
        const target = elementMap.get(operation.id);
        if (!target) {
          throw new Error(`Could not rename missing element ${operation.id}`);
        }
        if (target.type === "text") {
          updateTextElement(target, operation.label);
        } else if (target.type === "frame" || target.type === "magicframe") {
          target.name = operation.label;
        } else {
          const boundText = getBoundTextElement(target, elementMap);
          if (!boundText) {
            throw new Error(`Element ${operation.id} does not have editable bound text`);
          }
          updateTextElement(boundText, operation.label);
        }
        textChanged = true;
        applied.push(`rename:${operation.id}`);
        break;
      }
      case "move": {
        const target = elementMap.get(operation.id);
        if (!target) {
          throw new Error(`Could not move missing element ${operation.id}`);
        }
        const nextX = Number(operation.x);
        const nextY = Number(operation.y);
        if (!Number.isFinite(nextX) || !Number.isFinite(nextY)) {
          throw new Error(`move operation for ${operation.id} requires numeric x and y`);
        }
        const deltaX = nextX - target.x;
        const deltaY = nextY - target.y;
        target.x = nextX;
        target.y = nextY;
        const boundText = getBoundTextElement(target, elementMap);
        if (boundText) {
          boundText.x += deltaX;
          boundText.y += deltaY;
        }
        const regeneratedIds = new Set<string>();
        for (const reference of target.boundElements ?? []) {
          const linear = elementMap.get(reference.id);
          if (!linear || (linear.type !== "arrow" && linear.type !== "line")) {
            continue;
          }
          const fromId = linear.customData?.fromId ?? linear.startBinding?.elementId;
          const toId = linear.customData?.toId ?? linear.endBinding?.elementId;
          if (!fromId || !toId || regeneratedIds.has(linear.id)) {
            continue;
          }
          const [replacement] = convertEdgeAgainstExisting(elements, {
            id: linear.id,
            type: linear.type === "line" ? "line" : "arrow",
            from: fromId,
            to: toId,
            label: linear.label?.text ?? linear.customData?.label,
            style: {
              strokeColor: linear.strokeColor,
              backgroundColor: linear.backgroundColor,
              strokeWidth: linear.strokeWidth,
              strokeStyle: linear.strokeStyle,
              roughness: linear.roughness,
              opacity: linear.opacity,
              startArrowhead: linear.startArrowhead,
              endArrowhead: linear.endArrowhead,
            },
            customData: linear.customData,
          });
          if (!replacement) {
            continue;
          }
          elements = elements.map((element) => (element.id === linear.id ? replacement : element));
          attachLinearBindings(elements, replacement, fromId, toId);
          regeneratedIds.add(linear.id);
        }
        applied.push(`move:${operation.id}`);
        break;
      }
      case "set-style": {
        const target = elementMap.get(operation.id);
        if (!target) {
          throw new Error(`Could not style missing element ${operation.id}`);
        }
        Object.assign(target, operation.style ?? {});
        applied.push(`set-style:${operation.id}`);
        break;
      }
      case "add-node": {
        const created = convertToExcalidrawElements([buildNodeSkeleton(operation.node, parsed.appState)] as any, {
          regenerateIds: false,
        }) as GenericRecord[];
        elements = elements.concat(created);
        applied.push(`add-node:${operation.node.id}`);
        break;
      }
      case "connect": {
        elements = elements.concat(convertEdgeAgainstExisting(elements, operation));
        applied.push(`connect:${operation.from}->${operation.to}`);
        break;
      }
      case "delete": {
        elements = removeElementById(elements, operation.id);
        applied.push(`delete:${operation.id}`);
        break;
      }
      case "frame": {
        const frameId = operation.id ?? `frame-${crypto.randomUUID()}`;
        elements = elements.filter((element) => element.id !== frameId);
        const createdFrame = createFrameAgainstExisting(elements, { ...operation, id: frameId });
        elements = elements.concat(createdFrame);
        elements = elements.map((element) => (
          (operation.children ?? []).includes(element.id) ? { ...element, frameId } : element
        ));
        applied.push(`frame:${frameId}`);
        break;
      }
      default:
        throw new Error(`Unsupported patch operation: ${(operation as GenericRecord).op}`);
    }
  }

  const restoredElements = restoreElements(elements as any, null, {
    refreshDimensions: textChanged,
    repairBindings: true,
  }) as GenericRecord[];
  const repaired = autoRepairElements(restoredElements, files, parsed.kind, undefined);
  return {
    sceneText: serializeScene(repaired.elements, parsed.appState, files),
    report: {
      applied,
      refreshedTextDimensions: textChanged,
      autoFixes: repaired.autoFixes,
      qualityWarnings: repaired.report.qualityWarnings ?? [],
    },
  };
};

export const repairSceneText = (
  text: string,
  refreshTextDimensions: boolean,
): { kind: string; outputText: string; report: GenericRecord } => {
  const parsed = parseJson(text, "scene or library JSON");
  const rawDuplicateIds = getRawDuplicateIds(parsed.elements ?? []);
  if (parsed.type === "excalidrawlib") {
    const library = restoreLibraryText(text);
    return {
      kind: "library",
      outputText: library.itemsText,
      report: {
        itemCount: library.itemCount,
      },
    };
  }

  const restored = parseSceneLikeText(text, { refreshDimensions: refreshTextDimensions });
  const repaired = autoRepairElements(restored.elements, restored.files, restored.kind, undefined);
  return {
    kind: restored.kind,
    outputText: serializeScene(repaired.elements, restored.appState, restored.files),
    report: {
      ...inspectSceneData(repaired.elements, restored.files, restored.kind, rawDuplicateIds),
      autoFixes: repaired.autoFixes,
    },
  };
};

export const inspectSceneText = (text: string) => {
  const parsed = parseJson(text, "scene JSON");
  const rawDuplicateIds = getRawDuplicateIds(parsed.elements ?? []);
  const restored = parseSceneLikeText(text);
  return {
    report: inspectSceneData(restored.elements, restored.files, restored.kind, rawDuplicateIds),
  };
};
