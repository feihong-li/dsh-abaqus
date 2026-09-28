/**
 * Structured mesher and region resolution.
 *
 * The built-in mesher exists so the CalculiX backend can produce a genuine
 * runnable deck without any CAD or meshing tool: `box` becomes a mapped hex
 * grid, `cylinder` a mapped ring mesh with a wedge core when it is solid.
 * The Abaqus backend does not use this code at all — the CAE kernel meshes the
 * real geometry — but both share the region vocabulary, so a spec meansthe same
 * thing on either backend.
 */

const DEG = Math.PI / 180;

/** Abaqus face node tables, 1-based within an element. */
const HEX_FACES = [
  [1, 2, 3, 4],
  [5, 8, 7, 6],
  [1, 5, 6, 2],
  [2, 6, 7, 3],
  [3, 7, 8, 4],
  [4, 8, 5, 1],
];

/** CalculiX/Abaqus C3D6 (wedge) faces, 1-based within the element. */
const WEDGE_FACES = [
  [1, 2, 3],
  [4, 5, 6],
  [1, 2, 5, 4],
  [2, 3, 6, 5],
  [3, 1, 4, 6],
];

export function facesOf(element) {
  if (element.type === 'C3D6') return WEDGE_FACES;
  if (element.type === 'C3D4') return [[1, 2, 3], [1, 2, 4], [2, 3, 4], [3, 1, 4]];
  return HEX_FACES;
}

/** Extrinsic XYZ rotation matrix for three degree angles. */
function rotationMatrix([rx, ry, rz]) {
  const [cx, sx] = [Math.cos(rx * DEG), Math.sin(rx * DEG)];
  const [cy, sy] = [Math.cos(ry * DEG), Math.sin(ry * DEG)];
  const [cz, sz] = [Math.cos(rz * DEG), Math.sin(rz * DEG)];
  return [
    [cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx],
    [sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx],
    [-sy, cy * sx, cy * cx],
  ];
}

const applyRotation = (R, [x, y, z]) => [
  R[0][0] * x + R[0][1] * y + R[0][2] * z,
  R[1][0] * x + R[1][1] * y + R[1][2] * z,
  R[2][0] * x + R[2][1] * y + R[2][2] * z,
];

/** Rotate a locally-built (z-aligned) cylinder onto its requested axis. */
function axisRotation(axis) {
  if (axis === 'x') return rotationMatrix([0, 90, 0]);
  if (axis === 'y') return rotationMatrix([-90, 0, 0]);
  return rotationMatrix([0, 0, 0]);
}

/** Divisions from an explicit spec, the target element size, or a fallback. */
function divisionsFor(part, spec, extent, hints = {}) {
  const explicit = spec.mesh.divisions?.[part.name];
  if (Array.isArray(explicit)) {
    return extent.map((length, index) => {
      const wanted = explicit[index];
      if (Number.isFinite(wanted) && wanted >= 1) return Math.trunc(wanted);
      const fallback = hints[`axis${index}`] ?? 1;
      return Math.max(1, Math.min(fallback, 400));
    });
  }
  const size = Number(spec.mesh.size ?? 5);
  return extent.map((length) => Math.max(1, Math.min(400, Math.round(length / size) || 1)));
}

function meshBox(part, spec, hexType) {
  const [lx, ly, lz] = part.geometry.size;
  const [nx, ny, nz] = divisionsFor(part, spec, [lx, ly, lz]);
  const nodes = [];
  const at = (i, j, k) => i + (nx + 1) * (j + (ny + 1) * k) + 1;
  for (let k = 0; k <= nz; k += 1) {
    for (let j = 0; j <= ny; j += 1) {
      for (let i = 0; i <= nx; i += 1) {
        nodes.push({ x: (lx * i) / nx, y: (ly * j) / ny, z: (lz * k) / nz });
      }
    }
  }
  const elements = [];
  for (let k = 0; k < nz; k += 1) {
    for (let j = 0; j < ny; j += 1) {
      for (let i = 0; i < nx; i += 1) {
        elements.push({
          type: hexType,
          nodes: [at(i, j, k), at(i + 1, j, k), at(i + 1, j + 1, k), at(i, j + 1, k), at(i, j, k + 1), at(i + 1, j, k + 1), at(i + 1, j + 1, k + 1), at(i, j + 1, k + 1)],
          cell: [i, j, k],
          localAxis: ['x', 'y', 'z'],
        });
      }
    }
  }
  return { nodes, elements, divisions: [nx, ny, nz] };
}

/**
 * Mapped ring mesh. The cylinder is built along +z (base at z = 0, centred on
 * the z axis, which is also how Abaqus `BaseSolidCylinder` places it) and then
 * rotated onto the requested axis.
 */
function meshCylinder(part, spec, hexType) {
  const { radius, height, axis } = part.geometry;
  const inner = part.geometry.innerRadius ?? 0;
  const solidCore = inner <= 0;
  const nt = Math.max(4, Math.round((2 * Math.PI * radius) / (spec.mesh.size ?? 5)) || 8);
  const nz = Math.max(1, Math.round(height / (spec.mesh.size ?? 5)) || 1);
  const nr = inner > 0
    ? Math.max(1, Math.round((radius - inner) / (spec.mesh.size ?? 5)) || 1)
    : Math.max(1, Math.round(radius / (spec.mesh.size ?? 5)) || 1);
  const explicit = spec.mesh.divisions?.[part.name];
  const divisions = Array.isArray(explicit) && explicit.length === 3
    ? [Math.max(1, Math.trunc(explicit[0])), Math.max(4, Math.trunc(explicit[1])), Math.max(1, Math.trunc(explicit[2]))]
    : [nr, nt, nz];
  const [nRad, nTan, nAx] = divisions;

  const R = axisRotation(axis);
  const nodes = [];
  const push = (radiusValue, theta, z) => {
    const [x, y, zz] = applyRotation(R, [radiusValue * Math.cos(theta), radiusValue * Math.sin(theta), z]);
    nodes.push({ x, y, z: zz });
  };
  // A solid cylinder replaces the innermost ring with one node per axial station,
  // so the degenerate ring at radius 0 is never generated and never referenced.
  const firstRing = solidCore ? 1 : 0;
  const ringCount = nRad - firstRing + 1;
  const tubeIndex = (j, t, k) => {
    const tt = ((t % nTan) + nTan) % nTan;
    return (j - firstRing) + ringCount * (tt + nTan * k) + 1;
  };
  const coreIndex = (k) => ringCount * nTan * (nAx + 1) + k + 1;
  for (let k = 0; k <= nAx; k += 1) {
    for (let t = 0; t < nTan; t += 1) {
      for (let j = firstRing; j <= nRad; j += 1) {
        const r = inner + ((radius - inner) * j) / nRad;
        push(r, (2 * Math.PI * t) / nTan, (height * k) / nAx);
      }
    }
  }
  if (solidCore) {
    for (let k = 0; k <= nAx; k += 1) push(0, 0, (height * k) / nAx);
  }

  const elements = [];
  for (let k = 0; k < nAx; k += 1) {
    for (let t = 0; t < nTan; t += 1) {
      if (solidCore) {
        elements.push({
          type: 'C3D6',
          nodes: [coreIndex(k), tubeIndex(1, t, k), tubeIndex(1, t + 1, k), coreIndex(k + 1), tubeIndex(1, t, k + 1), tubeIndex(1, t + 1, k + 1)],
          cell: [0, t, k],
          localAxis: ['r', 't', 'z'],
        });
      }
      for (let j = firstRing; j < nRad; j += 1) {
        elements.push({
          type: hexType,
          nodes: [
            tubeIndex(j, t, k), tubeIndex(j + 1, t, k), tubeIndex(j + 1, t + 1, k), tubeIndex(j, t + 1, k),
            tubeIndex(j, t, k + 1), tubeIndex(j + 1, t, k + 1), tubeIndex(j + 1, t + 1, k + 1), tubeIndex(j, t + 1, k + 1),
          ],
          cell: [j, t, k],
          localAxis: ['r', 't', 'z'],
        });
      }
    }
  }
  return { nodes, elements, divisions };
}

/** Mesh one part in its own local frame. */
function meshPart(part, spec) {
  const hexType = spec.mesh.element ?? 'C3D8';
  if (part.geometry.kind === 'box') return meshBox(part, spec, hexType);
  if (part.geometry.kind === 'cylinder') return meshCylinder(part, spec, hexType);
  throw new Error(`no built-in mesher for geometry kind "${part.geometry.kind}"`);
}

/**
 * Build the whole assembly mesh in global coordinates.
 * @param {object} spec - a spec normalised by `parseSpec`.
 * @returns {object} nodes, elements, per-instance extents, named sets and stats.
 */
export function buildMesh(spec) {
  const warnings = [];
  const nodes = [];
  const elements = [];
  const instances = [];
  const sets = {};
  let nextNode = 1;
  let nextElement = 1;

  for (const instance of spec.instances) {
    const part = spec.parts.find((candidate) => candidate.name === instance.part);
    if (part === undefined) continue;
    const local = meshPart(part, spec);
    const R = rotationMatrix(instance.rotate);
    const nodeIds = [];
    const own = [];
    const idMap = new Map();
    for (const [index, node] of local.nodes.entries()) {
      const [x, y, z] = applyRotation(R, [node.x, node.y, node.z]);
      const id = nextNode;
      nextNode += 1;
      const global = { id, x: x + instance.translate[0], y: y + instance.translate[1], z: z + instance.translate[2] };
      nodes.push(global);
      own.push(global);
      nodeIds.push(id);
      idMap.set(index + 1, id);
    }
    const elementIds = [];
    for (const element of local.elements) {
      const mapped = element.nodes.map((index) => idMap.get(index));
      const id = nextElement;
      nextElement += 1;
      elements.push({
        id,
        type: element.type,
        nodes: mapped,
        instance: instance.name,
        part: part.name,
        cell: element.cell,
        localAxis: element.localAxis,
      });
      elementIds.push(id);
    }
    const bbox = {
      xMin: Math.min(...own.map((n) => n.x)), xMax: Math.max(...own.map((n) => n.x)),
      yMin: Math.min(...own.map((n) => n.y)), yMax: Math.max(...own.map((n) => n.y)),
      zMin: Math.min(...own.map((n) => n.z)), zMax: Math.max(...own.map((n) => n.z)),
    };
    instances.push({
      name: instance.name,
      part: part.name,
      nodeIds,
      elementIds,
      bbox,
      divisions: local.divisions,
      elementTypes: [...new Set(local.elements.map((e) => e.type))],
    });
    sets[`${instance.name}_NALL`] = { nodes: nodeIds, elements: [] };
    sets[`${instance.name}_EALL`] = { nodes: [], elements: elementIds };
    for (const axis of ['x', 'y', 'z']) {
      const low = own.filter((n) => Math.abs(n[axis] - bbox[`${axis}Min`]) <= toleranceOf(bbox));
      const high = own.filter((n) => Math.abs(n[axis] - bbox[`${axis}Max`]) <= toleranceOf(bbox));
      sets[`${instance.name}_${axis}min`] = { nodes: low.map((n) => n.id), elements: [] };
      sets[`${instance.name}_${axis}max`] = { nodes: high.map((n) => n.id), elements: [] };
    }
  }

  sets.NALL = { nodes: nodes.map((n) => n.id), elements: [] };
  sets.EALL = { nodes: [], elements: elements.map((e) => e.id) };

  const byType = {};
  for (const element of elements) byType[element.type] = (byType[element.type] ?? 0) + 1;

  // Integrity check: a node no element references is dropped by both solvers,
  // which would silently make the reported mesh size disagree with the results.
  const referenced = new Set();
  for (const element of elements) for (const id of element.nodes) referenced.add(id);
  if (referenced.size !== nodes.length) {
    warnings.push(`${nodes.length - referenced.size} node(s) are not referenced by any element and will be dropped by the solver`);
  }

  return {
    nodes,
    elements,
    instances,
    sets,
    warnings,
    stats: { nodeCount: nodes.length, elementCount: elements.length, byType },
  };
}

function toleranceOf(bbox) {
  const diagonal = Math.hypot(bbox.xMax - bbox.xMin, bbox.yMax - bbox.yMin, bbox.zMax - bbox.zMin);
  return Math.max(1e-9, 1e-7 * diagonal);
}

/**
 * Resolve a spec region against a generated mesh.
 * @returns {{nodeIds: number[], elementIds: number[], faces: Array<{elementId: number, faceNumber: number}>, label: string}}
 */
export function resolveRegion(region, mesh, instanceName) {
  const instance = mesh.instances.find((candidate) => candidate.name === instanceName) ?? mesh.instances[0];
  if (instance === undefined) throw new Error('the mesh has no instance to resolve the region against');
  const inInstance = (element) => element.instance === instance.name;
  const memberIds = new Set(instance.nodeIds);
  const elementById = new Map(mesh.elements.map((element) => [element.id, element]));
  const tolerance = toleranceOf(instance.bbox);

  const pickPlane = () => {
    const { axis, side, value } = region;
    const planeValue = side === 'min' ? instance.bbox[`${axis}Min`] : side === 'max' ? instance.bbox[`${axis}Max`] : value;
    const nodeIds = mesh.nodes.filter((node) => memberIds.has(node.id) && Math.abs(node[axis] - planeValue) <= tolerance).map((n) => n.id);
    const wanted = new Set(nodeIds);
    const elementIds = [];
    const faces = [];
    for (const element of mesh.elements) {
      if (!inInstance(element)) continue;
      const faceTable = facesOf(element);
      let touched = false;
      for (const [index, face] of faceTable.entries()) {
        if (face.every((local) => wanted.has(element.nodes[local - 1]))) {
          faces.push({ elementId: element.id, faceNumber: index + 1 });
          touched = true;
        }
      }
      if (touched) elementIds.push(element.id);
    }
    return { nodeIds, elementIds, faces, label: region.label ?? `${axis}${side}` };
  };

  if (region.kind === 'plane') return pickPlane();
  if (region.kind === 'bbox') {
    const nodeIds = mesh.nodes.filter((node) => {
      if (!memberIds.has(node.id)) return false;
      for (const [key, bound] of Object.entries(region.bbox)) {
        const axis = key[0];
        const isMin = key.endsWith('Min');
        if (isMin ? node[axis] < bound - tolerance : node[axis] > bound + tolerance) return false;
      }
      return true;
    }).map((n) => n.id);
    const wanted = new Set(nodeIds);
    const elementIds = mesh.elements
      .filter((element) => inInstance(element) && element.nodes.some((id) => wanted.has(id)))
      .map((element) => element.id);
    const faces = [];
    for (const id of elementIds) {
      const element = elementById.get(id);
      for (const [index, face] of facesOf(element).entries()) {
        if (face.every((local) => wanted.has(element.nodes[local - 1]))) faces.push({ elementId: id, faceNumber: index + 1 });
      }
    }
    return { nodeIds, elementIds, faces, label: 'bbox' };
  }
  if (region.kind === 'set') {
    const set = mesh.sets[region.set];
    if (set === undefined) {
      const available = Object.keys(mesh.sets).sort().join(', ');
      throw new Error(`region.set "${region.set}" does not exist; the mesher created: ${available}`);
    }
    const wanted = new Set(set.nodes);
    const elementIds = set.elements.length > 0
      ? [...set.elements]
      : mesh.elements.filter((element) => inInstance(element) && element.nodes.some((id) => wanted.has(id))).map((element) => element.id);
    const faces = [];
    for (const id of elementIds) {
      const element = elementById.get(id);
      if (element === undefined) continue;
      for (const [index, face] of facesOf(element).entries()) {
        if (face.every((local) => wanted.has(element.nodes[local - 1]))) faces.push({ elementId: id, faceNumber: index + 1 });
      }
    }
    return { nodeIds: set.nodes, elementIds, faces, label: region.set };
  }
  if (region.kind === 'nodes') return { nodeIds: [...region.nodes], elementIds: [], faces: [], label: `nodes(${region.nodes.length})` };
  if (region.kind === 'elements') {
    return { nodeIds: [], elementIds: [...region.elements], faces: [], label: `elements(${region.elements.length})` };
  }
  throw new Error(`unsupported region kind "${region.kind}"`);
}
