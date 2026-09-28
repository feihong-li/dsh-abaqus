/**
 * The declarative model specification: validation, normalisation and the
 * reference text handed to the model through the `abaqus_spec` tool.
 *
 * One spec describes the model; two backends consume it:
 *   - `abaqus`    builds it through the Abaqus CAE kernel (real geometry and
 *                 real CAE meshing) and writes an .inp deck,
 *   - `calculix`  meshes it with the built-in structured mesher and writes a
 *                 CalculiX-compatible .inp deck.
 * Both then solve the same deck convention, so results are comparable.
 */

const VECTOR3 = (value) =>
  Array.isArray(value) && value.length === 3 && value.every((n) => typeof n === 'number' && Number.isFinite(n));

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Degree-of-freedom names accepted in `dof`. */
const DOF_NAMES = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, x: 1, y: 2, z: 3 };
const DOF_LABELS = ['u1', 'u2', 'u3', 'ur1', 'ur2', 'ur3'];

/** Element types the built-in structured mesher can emit. */
export const MESHER_ELEMENTS = {
  C3D8: 'hex',
  C3D8R: 'hex',
  C3D8I: 'hex',
};

/** Element shapes the mesher can produce, by type name. */
export const HEX_ELEMENTS = ['C3D8', 'C3D8R', 'C3D8I'];

/** Analysis families shared by both backends. */
export const STEP_TYPES = ['static', 'freq', 'buckle', 'dynamic'];

function normalizeRegion(raw, where, errors) {
  if (!isPlainObject(raw)) {
    errors.push(`${where}: region must be an object such as {"plane":"x=min"} or {"set":"FIX"}`);
    return undefined;
  }
  if (typeof raw.set === 'string' && raw.set.trim() !== '') return { kind: 'set', set: raw.set.trim() };
  if (Array.isArray(raw.nodes) && raw.nodes.length > 0) {
    return { kind: 'nodes', nodes: raw.nodes.map((n) => Math.trunc(Number(n))) };
  }
  if (Array.isArray(raw.elements) && raw.elements.length > 0) {
    return { kind: 'elements', elements: raw.elements.map((n) => Math.trunc(Number(n))) };
  }
  if (typeof raw.plane === 'string') {
    const match = /^\s*([xyz])\s*=\s*(min|max|[-+0-9.eE]+)\s*$/.exec(raw.plane);
    if (match === null) {
      errors.push(`${where}: region.plane must look like "x=min", "y=max" or "z=12.5" (got "${raw.plane}")`);
      return undefined;
    }
    const side = match[2];
    return {
      kind: 'plane',
      axis: match[1],
      side: side === 'min' || side === 'max' ? side : 'at',
      value: side === 'min' || side === 'max' ? undefined : Number(side),
      label: `${match[1]}${side}`,
    };
  }
  if (isPlainObject(raw.bbox)) {
    const box = {};
    for (const key of ['xMin', 'xMax', 'yMin', 'yMax', 'zMin', 'zMax']) {
      if (raw.bbox[key] !== undefined) {
        const value = Number(raw.bbox[key]);
        if (!Number.isFinite(value)) {
          errors.push(`${where}: region.bbox.${key} must be a number`);
          return undefined;
        }
        box[key] = value;
      }
    }
    if (Object.keys(box).length === 0) {
      errors.push(`${where}: region.bbox needs at least one of xMin/xMax/yMin/yMax/zMin/zMax`);
      return undefined;
    }
    return { kind: 'bbox', bbox: box, label: 'bbox' };
  }
  errors.push(`${where}: region needs one of plane, bbox, set, nodes, elements`);
  return undefined;
}

function normalizeDof(raw, where, errors) {
  if (raw === undefined) return [1, 2, 3];
  const list = Array.isArray(raw) ? raw : [raw];
  const dof = [];
  for (const item of list) {
    const key = typeof item === 'string' ? item.trim().toLowerCase() : item;
    const resolved = DOF_NAMES[key];
    if (resolved === undefined) {
      errors.push(`${where}: dof entry ${JSON.stringify(item)} is not one of 1..6 or x/y/z`);
      continue;
    }
    if (!dof.includes(resolved)) dof.push(resolved);
  }
  dof.sort((a, b) => a - b);
  return dof.length > 0 ? dof : [1, 2, 3];
}

/**
 * Validate and normalise a model spec.
 * @param {unknown} raw - the model spec as supplied by the caller.
 * @returns {{spec: object|undefined, errors: string[], warnings: string[]}}
 */
export function parseSpec(raw) {
  const errors = [];
  const warnings = [];
  if (!isPlainObject(raw)) {
    return { spec: undefined, errors: ['spec must be an object'], warnings };
  }

  const name = typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name.trim() : 'model';
  const spec = {
    name,
    title: typeof raw.title === 'string' ? raw.title : name,
    units: typeof raw.units === 'string' ? raw.units : 'mm-N-MPa-tonne',
    materials: {},
    parts: [],
    instances: [],
    steps: [],
    boundaries: [],
    loads: [],
    mesh: { kind: 'hex', size: undefined, element: undefined, seedPart: false },
    output: { fields: ['S', 'U'], freq: 1 },
    writes: { frd: true, dat: false, nodePrint: [], elPrint: [] },
  };

  // ---- materials -----------------------------------------------------------
  const rawMaterials = isPlainObject(raw.materials) ? raw.materials : {};
  for (const [matName, mat] of Object.entries(rawMaterials)) {
    if (!isPlainObject(mat)) {
      errors.push(`materials.${matName}: must be an object`);
      continue;
    }
    const E = Number(mat.E ?? mat.youngsModulus);
    const nu = Number(mat.nu ?? mat.poisson ?? 0.3);
    if (!Number.isFinite(E) || E <= 0) errors.push(`materials.${matName}: E (Young's modulus) must be a positive number`);
    if (!Number.isFinite(nu) || nu <= -1 || nu >= 0.5) {
      errors.push(`materials.${matName}: nu (Poisson ratio) must be a number between -1 and 0.5`);
    }
    const material = { name: matName, E, nu, rho: undefined, plastic: [], expansion: undefined, conductivity: undefined, specificHeat: undefined, yield: undefined };
    if (mat.rho !== undefined || mat.density !== undefined) {
      const rho = Number(mat.rho ?? mat.density);
      if (!Number.isFinite(rho) || rho <= 0) errors.push(`materials.${matName}: rho must be a positive number`);
      else material.rho = rho;
    }
    if (Array.isArray(mat.plastic)) {
      for (const [index, entry] of mat.plastic.entries()) {
        if (!Array.isArray(entry) || entry.length < 2) {
          errors.push(`materials.${matName}.plastic[${index}]: must be [yieldStress, plasticStrain]`);
          continue;
        }
        material.plastic.push([Number(entry[0]), Number(entry[1])]);
      }
      if (material.plastic.length > 0) material.yield = material.plastic[0][0];
    } else if (mat.yield !== undefined) {
      const yieldStress = Number(mat.yield);
      material.plastic.push([yieldStress, 0]);
      material.yield = yieldStress;
    }
    if (mat.expansion !== undefined) material.expansion = Number(mat.expansion);
    if (mat.conductivity !== undefined) material.conductivity = Number(mat.conductivity);
    if (mat.specificHeat !== undefined) material.specificHeat = Number(mat.specificHeat);
    spec.materials[matName] = material;
  }
  if (Object.keys(spec.materials).length === 0) {
    errors.push('materials: at least one material is required (e.g. {"steel":{"E":210000,"nu":0.3,"rho":7.85e-9}})');
  }

  // ---- parts ---------------------------------------------------------------
  const rawParts = Array.isArray(raw.parts) ? raw.parts : [];
  if (rawParts.length === 0) errors.push('parts: at least one part is required');
  for (const [index, part] of rawParts.entries()) {
    const where = `parts[${index}]`;
    if (!isPlainObject(part)) {
      errors.push(`${where}: must be an object`);
      continue;
    }
    const partName = typeof part.name === 'string' && part.name.trim() !== '' ? part.name.trim() : `part${index + 1}`;
    const geometry = isPlainObject(part.geometry) ? { ...part.geometry } : undefined;
    if (geometry === undefined) {
      errors.push(`${where}.geometry: required, e.g. {"kind":"box","size":[100,10,10]}`);
      continue;
    }
    geometry.kind = String(geometry.kind ?? 'box').toLowerCase();
    if (geometry.kind === 'box') {
      const size = Array.isArray(geometry.size) ? geometry.size.map(Number) : undefined;
      if (size === undefined || size.length !== 3 || size.some((n) => !Number.isFinite(n) || n <= 0)) {
        errors.push(`${where}.geometry.size: box needs three positive numbers [Lx, Ly, Lz]`);
      } else geometry.size = size;
    } else if (geometry.kind === 'cylinder') {
      const radius = Number(geometry.radius);
      const height = Number(geometry.height ?? geometry.length);
      if (!Number.isFinite(radius) || radius <= 0) errors.push(`${where}.geometry.radius: cylinder needs a positive radius`);
      if (!Number.isFinite(height) || height <= 0) errors.push(`${where}.geometry.height: cylinder needs a positive height`);
      geometry.radius = radius;
      geometry.height = height;
      geometry.axis = String(geometry.axis ?? 'z').toLowerCase();
      if (!['x', 'y', 'z'].includes(geometry.axis)) errors.push(`${where}.geometry.axis: must be x, y or z`);
      if (geometry.innerRadius !== undefined) {
        const inner = Number(geometry.innerRadius);
        if (!Number.isFinite(inner) || inner < 0 || inner >= radius) {
          errors.push(`${where}.geometry.innerRadius: must be >= 0 and smaller than radius`);
        } else geometry.innerRadius = inner;
      }
    } else {
      errors.push(`${where}.geometry.kind: "${geometry.kind}" is not supported (box, cylinder)`);
    }
    const material = typeof part.material === 'string' ? part.material : Object.keys(spec.materials)[0];
    if (spec.materials[material] === undefined) {
      errors.push(`${where}.material: "${material}" is not declared in materials`);
    }
    const section = isPlainObject(part.section) ? { ...part.section } : { type: 'solid' };
    section.type = String(section.type ?? 'solid').toLowerCase();
    if (!['solid', 'shell'].includes(section.type)) {
      errors.push(`${where}.section.type: "${section.type}" is not supported (solid)`);
    }
    if (section.type === 'shell') {
      if (!(Number(section.thickness) > 0)) errors.push(`${where}.section.thickness: shell sections need a positive thickness`);
      errors.push(`${where}.section.type: shell sections are not implemented in v1 - both backends would silently solve a solid, so declare a solid section`);
    }
    spec.parts.push({ name: partName, geometry, material, section });
  }

  // ---- assembly ------------------------------------------------------------
  const partNames = new Set(spec.parts.map((p) => p.name));
  const rawAssembly = Array.isArray(raw.assembly) ? raw.assembly : [];
  if (rawAssembly.length === 0) {
    for (const part of spec.parts) {
      spec.instances.push({ name: part.name, part: part.name, translate: [0, 0, 0], rotate: [0, 0, 0] });
    }
  } else {
    for (const [index, entry] of rawAssembly.entries()) {
      const where = `assembly[${index}]`;
      if (!isPlainObject(entry)) {
        errors.push(`${where}: must be an object`);
        continue;
      }
      const part = typeof entry.part === 'string' ? entry.part : '';
      if (!partNames.has(part)) {
        errors.push(`${where}.part: "${part}" is not a declared part`);
        continue;
      }
      const translate = entry.translate ?? [0, 0, 0];
      const rotate = entry.rotate ?? [0, 0, 0];
      if (!VECTOR3(translate)) errors.push(`${where}.translate: must be three numbers`);
      if (!VECTOR3(rotate)) errors.push(`${where}.rotate: must be three numbers (degrees, applied X then Y then Z)`);
      spec.instances.push({
        name: typeof entry.name === 'string' && entry.name.trim() !== '' ? entry.name.trim() : `${part}-${index + 1}`,
        part,
        translate: VECTOR3(translate) ? translate.map(Number) : [0, 0, 0],
        rotate: VECTOR3(rotate) ? rotate.map(Number) : [0, 0, 0],
      });
    }
  }
  const instanceNames = new Set(spec.instances.map((i) => i.name));
  const pickInstance = (entry, where) => {
    if (typeof entry.instance === 'string' && entry.instance.trim() !== '') {
      if (!instanceNames.has(entry.instance)) {
        errors.push(`${where}.instance: "${entry.instance}" is not a declared instance`);
        return entry.instance;
      }
      return entry.instance;
    }
    return spec.instances[0]?.name;
  };

  // ---- steps ---------------------------------------------------------------
  const rawSteps = Array.isArray(raw.steps) && raw.steps.length > 0 ? raw.steps : [{ name: 'Load', type: 'static' }];
  for (const [index, step] of rawSteps.entries()) {
    const where = `steps[${index}]`;
    if (!isPlainObject(step)) {
      errors.push(`${where}: must be an object`);
      continue;
    }
    const stepName = typeof step.name === 'string' && step.name.trim() !== '' ? step.name.trim() : `Step-${index + 1}`;
    const type = String(step.type ?? 'static').toLowerCase();
    if (!STEP_TYPES.includes(type)) {
      errors.push(`${where}.type: "${type}" is not supported (${STEP_TYPES.join(', ')})`);
    }
    const increments = isPlainObject(step.increments) ? step.increments : {};
    const normalized = {
      name: stepName,
      type,
      previous: index === 0 ? 'Initial' : (typeof step.previous === 'string' ? step.previous : rawSteps[index - 1]?.name ?? 'Initial'),
      nlgeom: step.nlgeom === true,
      initialInc: Number(increments.initial ?? 0.1),
      period: Number(increments.period ?? 1),
      minInc: Number(increments.min ?? 1e-5),
      maxInc: Number(increments.max ?? increments.period ?? 1),
      eigenvalues: step.eigenvalues === undefined ? undefined : Math.max(1, Math.trunc(Number(step.eigenvalues))),
      description: typeof step.description === 'string' ? step.description : '',
    };
    if (type === 'static' || type === 'dynamic') {
      if (!(normalized.initialInc > 0)) errors.push(`${where}.increments.initial: must be > 0`);
      if (!(normalized.period > 0)) errors.push(`${where}.increments.period: must be > 0`);
      if (!(normalized.maxInc > 0)) errors.push(`${where}.increments.max: must be > 0`);
    }
    if ((type === 'freq' || type === 'buckle') && normalized.eigenvalues === undefined) {
      normalized.eigenvalues = 10;
      warnings.push(`${where}.eigenvalues: defaulted to 10`);
    }
    spec.steps.push(normalized);
  }
  const stepNames = new Set(spec.steps.map((s) => s.name));

  // ---- boundaries ----------------------------------------------------------
  for (const [index, entry] of (Array.isArray(raw.boundaries) ? raw.boundaries : []).entries()) {
    const where = `boundaries[${index}]`;
    if (!isPlainObject(entry)) {
      errors.push(`${where}: must be an object`);
      continue;
    }
    const step = typeof entry.step === 'string' ? entry.step : spec.steps[0].name;
    if (!stepNames.has(step)) errors.push(`${where}.step: "${step}" is not a declared step`);
    const instance = pickInstance(entry, where);
    // Validate the degrees of freedom independently of the region so that one
    // bad field never hides the other errors in the same entry.
    const dof = normalizeDof(entry.dof ?? entry.type, where, errors);
    const value = entry.value === undefined ? 0 : Number(entry.value);
    if (!Number.isFinite(value)) errors.push(`${where}.value: must be a number`);
    const region = normalizeRegion(entry.region, where, errors);
    if (region === undefined) continue;
    spec.boundaries.push({
      name: typeof entry.name === 'string' && entry.name.trim() !== '' ? entry.name.trim() : `BC-${index + 1}`,
      step,
      instance,
      region,
      dof,
      value,
      amplitude: entry.amplitude === undefined ? undefined : Number(entry.amplitude),
    });
  }
  if (spec.boundaries.length === 0) {
    warnings.push('boundaries: none declared, so the model is not restrained and both solvers will refuse to run');
  }

  // ---- loads ---------------------------------------------------------------
  for (const [index, entry] of (Array.isArray(raw.loads) ? raw.loads : []).entries()) {
    const where = `loads[${index}]`;
    if (!isPlainObject(entry)) {
      errors.push(`${where}: must be an object`);
      continue;
    }
    const type = String(entry.type ?? 'concentrated').toLowerCase();
    const step = typeof entry.step === 'string' ? entry.step : spec.steps[spec.steps.length - 1].name;
    if (!stepNames.has(step)) errors.push(`${where}.step: "${step}" is not a declared step`);
    const load = {
      name: typeof entry.name === 'string' && entry.name.trim() !== '' ? entry.name.trim() : `Load-${index + 1}`,
      step,
      type,
      instance: undefined,
      region: undefined,
      vector: undefined,
      value: undefined,
      total: entry.total !== false,
      follow: entry.follow === true,
    };
    if (type === 'gravity') {
      if (!VECTOR3(entry.vector)) errors.push(`${where}.vector: gravity needs three numbers (an acceleration vector)`);
      else load.vector = entry.vector.map(Number);
    } else if (type === 'concentrated') {
      load.instance = pickInstance(entry, where);
      if (!VECTOR3(entry.vector)) errors.push(`${where}.vector: concentrated loads need three force components`);
      else load.vector = entry.vector.map(Number);
      if (entry.total === undefined) warnings.push(`${where}.total: defaulted to true (vector is the resultant, split over the region)`);
      load.region = normalizeRegion(entry.region, where, errors);
      if (load.region === undefined) continue;
    } else if (type === 'pressure') {
      load.instance = pickInstance(entry, where);
      const value = Number(entry.value ?? entry.magnitude);
      if (!Number.isFinite(value)) errors.push(`${where}.value: pressure needs a number`);
      else load.value = value;
      load.region = normalizeRegion(entry.region, where, errors);
      if (load.region === undefined) continue;
    } else if (type === 'traction') {
      load.instance = pickInstance(entry, where);
      if (!VECTOR3(entry.vector)) errors.push(`${where}.vector: traction needs three numbers`);
      else load.vector = entry.vector.map(Number);
      load.region = normalizeRegion(entry.region, where, errors);
      if (load.region === undefined) continue;
    } else {
      errors.push(`${where}.type: "${type}" is not supported (concentrated, pressure, gravity, traction)`);
      continue;
    }
    spec.loads.push(load);
  }

  // ---- mesh ----------------------------------------------------------------
  if (isPlainObject(raw.mesh)) {
    spec.mesh.kind = String(raw.mesh.kind ?? 'hex').toLowerCase();
    if (raw.mesh.size !== undefined) {
      const size = Number(raw.mesh.size);
      if (!Number.isFinite(size) || size <= 0) errors.push('mesh.size: must be a positive number');
      else spec.mesh.size = size;
    }
    if (raw.mesh.element !== undefined) {
      const element = String(raw.mesh.element).toUpperCase();
      if (!HEX_ELEMENTS.includes(element)) {
        errors.push(
          `mesh.element: "${element}" is not emitted by the built-in mesher (${HEX_ELEMENTS.join(', ')}). `
          + 'A solid cylinder core is always C3D6, and tets need an external mesher: use the abaqus backend for C3D4.',
        );
      } else spec.mesh.element = element;
    }
    spec.mesh.seedPart = raw.mesh.seedPart === true;
    if (isPlainObject(raw.mesh.divisions)) {
      spec.mesh.divisions = {};
      for (const [key, value] of Object.entries(raw.mesh.divisions)) {
        const divisions = Math.max(1, Math.trunc(Number(value)));
        if (Number.isFinite(divisions)) spec.mesh.divisions[key] = divisions;
      }
    }
  }
  if (spec.mesh.size === undefined && spec.mesh.divisions === undefined) {
    spec.mesh.size = 5;
    warnings.push('mesh.size: defaulted to 5 model units');
  }

  // ---- output --------------------------------------------------------------
  if (isPlainObject(raw.output)) {
    if (Array.isArray(raw.output.fields) && raw.output.fields.length > 0) {
      spec.output.fields = raw.output.fields.map((f) => String(f).toUpperCase());
    }
    if (raw.output.freq !== undefined) spec.output.freq = Math.max(1, Math.trunc(Number(raw.output.freq)));
  }
  if (isPlainObject(raw.writes)) {
    const writes = raw.writes;
    if (writes.frd !== undefined) spec.writes.frd = writes.frd !== false;
    if (writes.dat !== undefined) spec.writes.dat = writes.dat === true;
    if (Array.isArray(writes.nodePrint)) spec.writes.nodePrint = writes.nodePrint.map((s) => String(s));
    if (Array.isArray(writes.elPrint)) spec.writes.elPrint = writes.elPrint.map((s) => String(s));
  }

  return { spec: errors.length === 0 ? spec : undefined, errors, warnings };
}

/** The DSL reference returned by the `abaqus_spec` tool. */
export const SPEC_REFERENCE = `# Abaqus/CalculiX model spec (v1)

A spec is one JSON object. Pick a consistent unit system and use it everywhere;
see "units" below for the reference system and the density trap.

## Top level
  name        string   model + file base name
  units       string   informational only
  materials   object   material name -> definition
  parts       array    geometry + material + section
  assembly    array    optional instance placement (default: one instance per part at the origin)
  steps       array    analysis procedures (default: one static step named "Load")
  boundaries  array    displacement BCs
  loads       array    concentrated / pressure / gravity / traction
  mesh        object   { size, element, divisions } for the built-in mesher
  output      object   { fields: ["S","U"], freq: 1 }

## materials.<name>
  E, nu                  required, linear elastic
  rho                    density (required by gravity / dynamic / freq steps)
  plastic: [[yield, plasticStrain], ...]
  yield                  shortcut for plastic: [[yield, 0]]
  expansion, conductivity, specificHeat

## parts[i]
  name                   string
  material               material name (default: the first declared material)
  geometry               { "kind": "box", "size": [Lx, Ly, Lz] }
                         { "kind": "cylinder", "radius": R, "height": H,
                           "axis": "z", "innerRadius": r }   // innerRadius > 0 -> tube
  section                { "type": "solid" }   // shell sections are rejected in v1:
                                              // declaring one would silently solve a solid
  geometry kinds         box, cylinder          (see parts[i] below)

## units
  Pick ONE consistent system and use it everywhere. The reference system for this
  plugin is mm / N / MPa / tonne / s, in which case:
    E, stresses        MPa  (N/mm^2),   e.g. steel 210000
    rho                tonne/mm^3,      e.g. steel 7.85e-9
    force              N
    acceleration       mm/s^2,          e.g. standard gravity 9810
    time               s
  A rho of 7.85e-3 (kg/m^3 habit) with mm geometry gives results that are wrong by
  10^12; check that E/rho is a sane wave-speed-squared before trusting a gravity,
  dynamic or freq result.

## steps[i]
  name, type             type: static | freq | buckle | dynamic
  nlgeom                 true for large displacement
  increments             { initial: 0.1, period: 1, min: 1e-5, max: 0.1 }
                         period  = total step time, i.e. the load scale factor at the
                                   end of the step (1 = apply the full load)
                         initial = first increment size, min/max bound every later one
                         The full load lands in ONE increment when initial = max = period.
                         Keep max well below period (0.1 default) for a nonlinear or
                         contact model so the solver can cut back.
  eigenvalues            number of modes (freq / buckle; default 10)
                         A freq step reports one result frame per mode, and mode shapes
                         are arbitrarily scaled, so only the frequencies are physical.

## boundaries[i]
  step, instance, dof, value, name
  dof                    [1,2,3] or ["x","y","z"] or [1..6]
  region                 see "Regions"
  The boundary 'name' is only a label; it is NOT the set name in the deck (see
  "Named sets").

## loads[i]
  step, instance, name, type
  type "concentrated"    vector: [Fx, Fy, Fz]; total: true -> vector is the resultant
                         spread evenly over the region's nodes (default true)
  type "pressure"        value: p, acting INTO the face (positive = compressive)
  type "gravity"         vector: acceleration vector, e.g. [0, -9810, 0] in mm/s^2
  type "traction"        vector: surface traction components (Abaqus backend only)

## Regions
  { "plane": "x=min" }            the instance face at the low x extent; also x=max,
                                  y=min, y=max, z=min, z=max, or z=<number>
  { "bbox": { "xMin": 0, "xMax": 0.001 } }   explicit bounding box, any of the six bounds
  { "set": "NAME" }               a named node set; with the calculix backend use one of
                                  the mesher names listed under "Named sets"
  { "nodes": [1, 2, 3] }          explicit node ids (calculix backend only)
  { "elements": [1, 2, 3] }       explicit element ids (calculix backend only)

  plane and bbox are resolved by bounding box, so a face that merely shares a
  bounding plane with another face (a step or a shoulder in the geometry) selects
  both. Curved faces (a cylinder bore, a fillet) have no bounding-box plane and
  cannot be addressed in v1.

  Backend support: plane/bbox work on both. 'set', 'nodes' and 'elements' are
  resolved from the built-in mesher, so the abaqus backend accepts 'set' only for
  a set the CAE script itself created (it names them SET_<boundary or load name>);
  use plane/bbox for portable specs.

## Named sets
  The built-in mesher creates exactly these sets, writes them into the deck as
  *NSET / *ELSET with these exact names, and abaqus_results accepts the same names:
    NALL, EALL                             every node / every element
    <instance>_NALL, <instance>_EALL       one instance
    <instance>_{x|y|z}{min|max}            one bounding plane of one instance
  Example: a part named "plate" gets plate_xmin, plate_xmax, plate_ymin, ... The spec
  regions {"plane":"x=max"} on that instance resolve to plate_xmax, and a boundary or
  load whose region is not one of these gets a fresh set named after the boundary or
  load plus _N (e.g. FIX_N). Grep the .inp for *NSET to see them all.

## mesh
  size                   target element size; the built-in mesher rounds the division
                         count per axis to the nearest whole number and reports the
                         element count. A 4 mm dimension at size 2 gets exactly 2
                         elements through the thickness, which is usually too coarse
                         for bending: watch the ZZ error estimate in the results.
  element                C3D8 | C3D8R | C3D8I (default C3D8). A solid cylinder core is
                         always C3D6; tets (C3D4) need an external mesher, so use the
                         abaqus backend for them.
  divisions              { "beam": [10, 2, 2] } explicit per-part division counts,
                         overriding 'size'. Box order is [nx, ny, nz]; cylinder order is
                         [radial, tangential, axial]. The resulting counts are in the
                         build result's mesh stats and in <name>.case.json.
  kind                   "hex", the only implemented mesher. Accepted and ignored.

## Files in the case directory
  <name>.inp            the deck (calculix backend)
  build_<name>.py       the CAE build script (abaqus backend)
  <name>.case.json      the normalised spec + mesh stats, written by abaqus_build
  <name>.run.json       exit code, command line and timing of the last abaqus_run
  <name>.stdout.log     captured solver output
  <name>.frd/.sta/.dat/.cvg/.12d, spooles.out   solver scratch, written by ccx itself

## Reading results
  abaqus_results reports max/min |U|, max von Mises and, for a selected node set, the
  per-node values (default: the first 20; raise maxNodes to see more, or read the
  written CSV). It also reports the Zienkiewicz-Zhu stress error estimate that ccx
  writes unconditionally: a percentage of the discretisation error, mean under ~10%
  is a reasonable mesh, and a large mean near a stress concentration means refine
  there. It is not requestable through output.fields.

## The two backends
  calculix   the built-in structured mesher writes the deck; solves with ccx.exe.
             Regions are resolved to node/element sets from the generated mesh.
  abaqus     a generated Abaqus/CAE python script builds the real geometry, meshes it
             with the CAE mesher and writes the deck; solves with abaqus job=. The CAE
             backend has never been executed during development (no Abaqus licence was
             available), so treat its output as unverified.`;

/** A worked example: cantilever beam with an analytical tip-deflection reference. */
export const EXAMPLE_SPEC = {
  name: 'cantilever',
  units: 'mm-N-MPa-tonne',
  materials: {
    steel: { E: 210000, nu: 0.3, rho: 7.85e-9 },
  },
  parts: [
    { name: 'beam', material: 'steel', geometry: { kind: 'box', size: [100, 10, 10] }, section: { type: 'solid' } },
  ],
  steps: [{ name: 'Load', type: 'static', nlgeom: false, increments: { initial: 0.1, period: 1, min: 1e-5, max: 0.1 } }],
  boundaries: [{ name: 'FIX', step: 'Load', instance: 'beam', region: { plane: 'x=min' }, dof: [1, 2, 3] }],
  loads: [
    { name: 'TIP', step: 'Load', instance: 'beam', type: 'concentrated', region: { plane: 'x=max' }, vector: [0, -100, 0], total: true },
  ],
  mesh: { kind: 'hex', size: 2.5, element: 'C3D8' },
  output: { fields: ['S', 'U'], freq: 1 },
};
