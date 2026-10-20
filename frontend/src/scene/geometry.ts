// Geometry builders for the security lattice. All pieces are built once and shared.

import * as THREE from "three";

export interface Facet {
  centroid: THREE.Vector3;
  basis: THREE.Matrix4; // local XY = face plane, local +Z = outward normal
  order: number; // 0 = topmost face; used to sweep effects with the evaluator ring
}

/** The 20 faces of an icosahedron as centroid and orientation, plus the face circumradius. */
export function icosahedronFacets(radius: number): { facets: Facet[]; circumradius: number } {
  const source = new THREE.IcosahedronGeometry(radius, 0); // polyhedra are non-indexed
  const position = source.getAttribute("position");
  const facets: Facet[] = [];
  let circumradius = 0;
  const [a, b, c] = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  for (let i = 0; i < position.count; i += 3) {
    a.fromBufferAttribute(position, i);
    b.fromBufferAttribute(position, i + 1);
    c.fromBufferAttribute(position, i + 2);
    const centroid = new THREE.Vector3().add(a).add(b).add(c).divideScalar(3);
    const z = centroid.clone().normalize();
    const x = a.clone().sub(centroid).normalize();
    const y = new THREE.Vector3().crossVectors(z, x);
    facets.push({ centroid, basis: new THREE.Matrix4().makeBasis(x, y, z), order: 0 });
    circumradius = a.distanceTo(centroid);
  }
  source.dispose();
  [...facets].sort((f, g) => g.centroid.y - f.centroid.y).forEach((facet, i) => (facet.order = i));
  return { facets, circumradius };
}

/** A bevelled triangular plate in local XY with vertex 0 on +X; thickness runs along Z. */
export function facetPlate(circumradius: number, thickness: number, bevel: number) {
  const ring = (r: number, z: number) =>
    [0, 1, 2].map((k) => new THREE.Vector3(r * Math.cos((k * 2 * Math.PI) / 3), r * Math.sin((k * 2 * Math.PI) / 3), z));
  const top = ring(circumradius * (1 - bevel), thickness / 2);
  const shoulder = ring(circumradius, thickness * 0.15);
  const bottom = ring(circumradius, -thickness / 2);
  const points: THREE.Vector3[] = [top[0], top[1], top[2], bottom[0], bottom[2], bottom[1]];
  const quad = (p: THREE.Vector3, q: THREE.Vector3, r: THREE.Vector3, s: THREE.Vector3) => points.push(p, q, r, p, r, s);
  for (let k = 0; k < 3; k++) {
    const n = (k + 1) % 3;
    quad(shoulder[k], shoulder[n], top[n], top[k]); // chamfer catches the light
    quad(bottom[k], bottom[n], shoulder[n], shoulder[k]);
  }
  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  geometry.computeVertexNormals();
  return geometry;
}

/** One iris blade: a 60° wedge whose outer chord lies on local Y and whose tip points to -X. */
export function irisBlade(radius: number) {
  const h = radius * Math.cos(Math.PI / 6);
  const shape = new THREE.Shape([
    new THREE.Vector2(0, -radius / 2),
    new THREE.Vector2(0, radius / 2),
    new THREE.Vector2(-h, 0),
  ]);
  return new THREE.ExtrudeGeometry(shape, { depth: 0.014, bevelEnabled: false }).translate(0, 0, -0.007);
}

/** Wall panel with one circular gateway, in local XY facing +Z. */
export function wallPanel(width: number, height: number, centerY: number, gatewayY: number, gatewayR: number) {
  const shape = new THREE.Shape();
  shape.moveTo(-width / 2, -height / 2);
  shape.lineTo(width / 2, -height / 2);
  shape.lineTo(width / 2, height / 2);
  shape.lineTo(-width / 2, height / 2);
  shape.closePath();
  const gateway = new THREE.Path();
  gateway.absarc(0, gatewayY - centerY, gatewayR, 0, Math.PI * 2, true);
  shape.holes.push(gateway);
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: 0.04, bevelEnabled: false, curveSegments: 48 });
  geometry.translate(0, centerY, -0.02);
  return geometry;
}

/** A horizontal probe line across a wall, split around the gateway, slightly in front of the panel. */
export function probeLine(width: number, y: number, gatewayY: number, gatewayR: number) {
  const clearance = gatewayR + 0.06;
  const dy = y - gatewayY;
  const z = 0.03;
  const points =
    Math.abs(dy) < clearance
      ? (() => {
          const half = Math.sqrt(clearance ** 2 - dy ** 2);
          return [
            new THREE.Vector3(-width / 2, y, z),
            new THREE.Vector3(-half, y, z),
            new THREE.Vector3(half, y, z),
            new THREE.Vector3(width / 2, y, z),
          ];
        })()
      : [new THREE.Vector3(-width / 2, y, z), new THREE.Vector3(width / 2, y, z)];
  return new THREE.BufferGeometry().setFromPoints(points);
}

export function shadowTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 128;
  const context = canvas.getContext("2d")!;
  const gradient = context.createRadialGradient(64, 64, 0, 64, 64, 64);
  gradient.addColorStop(0, "rgba(0,0,0,0.55)");
  gradient.addColorStop(1, "rgba(0,0,0,0)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(canvas);
}
