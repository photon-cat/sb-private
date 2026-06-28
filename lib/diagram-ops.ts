import type { Diagram, DiagramPart, DiagramConnection, DiagramLabel } from "./diagram-parser";

export function addPart(diagram: Diagram, part: DiagramPart): Diagram {
  return { ...diagram, parts: [...diagram.parts, part] };
}

export function removePart(diagram: Diagram, partId: string): Diagram {
  const parts = diagram.parts.filter((p) => p.id !== partId);
  const connections = diagram.connections.filter(
    (c) => !c.from.startsWith(`${partId}:`) && !c.to.startsWith(`${partId}:`),
  );
  const labels = diagram.labels?.filter((l) => !l.pinRef.startsWith(`${partId}:`));
  return { ...diagram, parts, connections, labels };
}

export function updatePart(
  diagram: Diagram,
  partId: string,
  update: Partial<DiagramPart>,
): Diagram {
  return {
    ...diagram,
    parts: diagram.parts.map((p) => (p.id === partId ? { ...p, ...update } : p)),
  };
}

export function movePart(
  diagram: Diagram,
  partId: string,
  left: number,
  top: number,
): Diagram {
  return updatePart(diagram, partId, { left, top });
}

export function rotatePart(diagram: Diagram, partId: string, angle: number): Diagram {
  const part = diagram.parts.find((p) => p.id === partId);
  if (!part) return diagram;
  return updatePart(diagram, partId, {
    rotate: ((part.rotate ?? 0) + angle) % 360,
  });
}

export function setPartAttr(
  diagram: Diagram,
  partId: string,
  key: string,
  value: string,
): Diagram {
  const part = diagram.parts.find((p) => p.id === partId);
  if (!part) return diagram;
  const newAttrs = { ...part.attrs };
  if (value === "") {
    delete newAttrs[key];
  } else {
    newAttrs[key] = value;
  }
  return updatePart(diagram, partId, { attrs: newAttrs });
}

export function setPartField(
  diagram: Diagram,
  partId: string,
  field: "value" | "footprint",
  value: string,
): Diagram {
  return updatePart(diagram, partId, { [field]: value || undefined });
}

export function duplicatePart(
  diagram: Diagram,
  partId: string,
  newId: string,
  offsetTop = 20,
  offsetLeft = 20,
): Diagram {
  const part = diagram.parts.find((p) => p.id === partId);
  if (!part) return diagram;
  const newPart: DiagramPart = {
    ...part,
    id: newId,
    top: part.top + offsetTop,
    left: part.left + offsetLeft,
  };
  return addPart(diagram, newPart);
}

export function addConnection(diagram: Diagram, conn: DiagramConnection): Diagram {
  return { ...diagram, connections: [...diagram.connections, conn] };
}

export function removeConnection(diagram: Diagram, index: number): Diagram {
  return {
    ...diagram,
    connections: diagram.connections.filter((_, i) => i !== index),
  };
}

export function updateConnection(
  diagram: Diagram,
  index: number,
  conn: DiagramConnection,
): Diagram {
  return {
    ...diagram,
    connections: diagram.connections.map((c, i) => (i === index ? conn : c)),
  };
}

export function setConnectionColor(
  diagram: Diagram,
  index: number,
  color: string,
): Diagram {
  const conn = diagram.connections[index];
  if (!conn) return diagram;
  const updated: DiagramConnection = { ...conn, color };
  return updateConnection(diagram, index, updated);
}

export function addLabel(diagram: Diagram, label: DiagramLabel): Diagram {
  return { ...diagram, labels: [...(diagram.labels ?? []), label] };
}

export function removeLabel(diagram: Diagram, labelId: string): Diagram {
  return {
    ...diagram,
    labels: (diagram.labels ?? []).filter((l) => l.id !== labelId),
  };
}

export function emptyDiagram(): Diagram {
  return {
    version: 1,
    author: "",
    editor: "sparkbench",
    parts: [],
    connections: [],
    labels: [],
  };
}
