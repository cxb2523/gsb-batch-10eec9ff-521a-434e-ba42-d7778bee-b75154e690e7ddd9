import {
  BufferGeometry,
  Float32BufferAttribute
} from 'three';

const THREE = window.THREE
  ? window.THREE // Prefer consumption from global THREE, if exists
  : {
  BufferGeometry,
  Float32BufferAttribute
};

import { merge as flatten } from 'd3-array';
import { flatten as earcutFlatten } from 'earcut';

import geoPolygonTriangulate from './geoPolygonTriangulate';

// support both modes for backwards threejs compatibility
const setAttributeFn = new THREE.BufferGeometry().setAttribute ? 'setAttribute' : 'addAttribute';

class ConicPolygonGeometry extends THREE.BufferGeometry {
  constructor(polygonGeoJson, bottomHeight, topHeight, closedBottom, closedTop, includeSides, curvatureResolution) {
    super();

    this.type = 'ConicPolygonGeometry';

    this.parameters = {
      polygonGeoJson,
      bottomHeight,
      topHeight,
      closedBottom,
      closedTop,
      includeSides,
      curvatureResolution
    };

    // defaults
    bottomHeight = bottomHeight || 0;
    topHeight = topHeight || 1;
    closedBottom = closedBottom !== undefined ? closedBottom : true;
    closedTop = closedTop !== undefined ? closedTop : true;
    includeSides = includeSides !== undefined ? includeSides : true;
    curvatureResolution = curvatureResolution || 5; // in angular degrees

    // pre-calculate contour, triangulation and UV maps
    const { contour, triangles } = geoPolygonTriangulate(polygonGeoJson, {resolution: curvatureResolution});
    const flatUvs = flatten(triangles.uvs);

    // A single altitude evaluation per (lng, lat) is shared by the torso and both caps,
    // so coincident seam vertices always derive from the exact same height value even if
    // the accessor is non-deterministic. Constants keep their fast path.
    const makeAltitudeEvaluator = altitude => {
      if (typeof altitude !== 'function') return () => altitude;

      const cache = new Map();
      return (lng, lat) => {
        const key = `${lng}-${lat}`;
        if (!cache.has(key)) cache.set(key, altitude(lng, lat));
        return cache.get(key);
      };
    };

    const bottomAlt = makeAltitudeEvaluator(bottomHeight);
    const topAlt = makeAltitudeEvaluator(topHeight);

    let vertices = [];
    let uvs = [];
    let indices = [];
    let groupCnt = 0; // add groups to apply different materials to torso / caps

    const addGroup = groupData => {
      const prevVertCnt = Math.round(vertices.length / 3);
      const prevIndCnt = indices.length;

      vertices = vertices.concat(groupData.vertices);
      uvs = uvs.concat(groupData.uvs);
      indices = indices.concat(!prevVertCnt ? groupData.indices : groupData.indices.map(ind => ind + prevVertCnt));

      this.addGroup(prevIndCnt, indices.length - prevIndCnt, groupCnt++);
    };

    includeSides && addGroup(generateTorso());
    closedBottom && addGroup(generateCap(bottomAlt, false));
    closedTop && addGroup(generateCap(topAlt, true));

    // build geometry
    this.setIndex(indices);
    this[setAttributeFn]('position', new THREE.Float32BufferAttribute(vertices, 3));
    this[setAttributeFn]('uv', new THREE.Float32BufferAttribute(uvs, 2));

    // auto-calculate normals.
    // With altitude accessor functions the side/cap seam vertices must share a smoothed
    // normal; constant altitudes keep the exact legacy per-vertex calculation.
    const hasAltitudeFn = typeof bottomHeight === 'function' || typeof topHeight === 'function';
    if (hasAltitudeFn && includeSides && (closedBottom || closedTop)) {
      computeSeamSmoothedVertexNormals(this, setAttributeFn);
    } else {
      this.computeVertexNormals();
    }

    //

    function generateVertices(polygon, altitudeFn) {
      const coords3d = polygon.map(coords => coords.map(([lng, lat]) => polar2Cartesian(lat, lng, altitudeFn(lng, lat))));
      // returns { vertices, holes, coordinates }. Each point generates 3 vertice items (x,y,z).
      return earcutFlatten(coords3d);
    }

    function generateTorso() {
      const {vertices: bottomVerts, holes} = generateVertices(contour, bottomAlt);
      const {vertices: topVerts} = generateVertices(contour, topAlt);

      const vertices = flatten([topVerts, bottomVerts]);
      const numPoints = Math.round(topVerts.length / 3);

      const holesIdx = new Set(holes);
      let lastHoleIdx = 0;

      const indices = [];
      for (let v0Idx = 0; v0Idx < numPoints; v0Idx++) {
        let v1Idx = v0Idx + 1; // next point
        if (v1Idx === numPoints) {
          v1Idx = lastHoleIdx; // close final loop
        } else if (holesIdx.has(v1Idx)) {
          const holeIdx = v1Idx;
          v1Idx = lastHoleIdx; // close hole loop
          lastHoleIdx = holeIdx;
        }

        // Each pair of coords generates two triangles (faces)
        indices.push(v0Idx, v0Idx + numPoints, v1Idx + numPoints);
        indices.push(v1Idx + numPoints, v1Idx, v0Idx);
      }

      const uvs = []; // wrap texture around perimeter (u), with v=1 on top
      for (let v=1; v>=0; v--)
        for (let i=0; i<numPoints; i+=1)
          uvs.push(i/(numPoints-1), v);

      return { indices, vertices, uvs };
    }

    function generateCap(altitudeFn, isTop = true) {
      return {
        // need to reverse-wind the bottom triangles to make them face outwards
        indices: isTop ? triangles.indices : triangles.indices.slice().reverse(),
        vertices: generateVertices([triangles.points], altitudeFn).vertices,
        uvs: flatUvs
      }
    }
  }

  clone() {
    return new ConicPolygonGeometry(
      this.parameters.polygonGeoJson,
      this.parameters.bottomHeight,
      this.parameters.topHeight,
      this.parameters.closedBottom,
      this.parameters.closedTop,
      this.parameters.includeSides,
      this.parameters.curvatureResolution
    ).copy(this);
  }
}

//

// Equivalent to BufferGeometry.computeVertexNormals, but vertices that sit on the same
// 3D position (the side/cap seams) accumulate their face normals together so the lighting
// normal transitions smoothly across the seam instead of bending sharply.
function computeSeamSmoothedVertexNormals(geometry, setAttrFn) {
  const index = geometry.index;
  const positionAttribute = geometry.attributes.position;

  const vertexCount = positionAttribute.count;
  const normals = new Float32Array(vertexCount * 3);

  if (index) {
    // welded indices: vertices with identical positions share their normal accumulator
    const weldMap = new Map();
    const representative = new Uint32Array(vertexCount);
    for (let i = 0; i < vertexCount; i++) {
      const x = positionAttribute.getX(i);
      const y = positionAttribute.getY(i);
      const z = positionAttribute.getZ(i);
      // quantize to float32 epsilon scale so mathematically-equal positions key together
      const key = `${Math.round(x * 1e7)}-${Math.round(y * 1e7)}-${Math.round(z * 1e7)}`;
      let rep = weldMap.get(key);
      if (rep === undefined) {
        rep = i;
        weldMap.set(key, rep);
      }
      representative[i] = rep;
    }

    const indices = index.array;
    for (let i = 0, il = indices.length; i < il; i += 3) {
      const vA = representative[indices[i]];
      const vB = representative[indices[i + 1]];
      const vC = representative[indices[i + 2]];

      const ax = positionAttribute.getX(vA), ay = positionAttribute.getY(vA), az = positionAttribute.getZ(vA);
      const bx = positionAttribute.getX(vB), by = positionAttribute.getY(vB), bz = positionAttribute.getZ(vB);
      const cx = positionAttribute.getX(vC), cy = positionAttribute.getY(vC), cz = positionAttribute.getZ(vC);

      const cbx = cx - bx, cby = cy - by, cbz = cz - bz;
      const abx = ax - bx, aby = ay - by, abz = az - bz;

      const nx = aby * cbz - abz * cby;
      const ny = abz * cbx - abx * cbz;
      const nz = abx * cby - aby * cbx;

      normals[vA * 3] += nx; normals[vA * 3 + 1] += ny; normals[vA * 3 + 2] += nz;
      normals[vB * 3] += nx; normals[vB * 3 + 1] += ny; normals[vB * 3 + 2] += nz;
      normals[vC * 3] += nx; normals[vC * 3 + 1] += ny; normals[vC * 3 + 2] += nz;
    }

    // propagate the accumulated normal from each representative to all of its welded vertices
    for (let i = 0; i < vertexCount; i++) {
      const rep = representative[i];
      if (rep !== i) {
        normals[i * 3] = normals[rep * 3];
        normals[i * 3 + 1] = normals[rep * 3 + 1];
        normals[i * 3 + 2] = normals[rep * 3 + 2];
      }
    }
  } else {
    for (let i = 0; i < vertexCount; i += 3) {
      const ax = positionAttribute.getX(i), ay = positionAttribute.getY(i), az = positionAttribute.getZ(i);
      const bx = positionAttribute.getX(i + 1), by = positionAttribute.getY(i + 1), bz = positionAttribute.getZ(i + 1);
      const cx = positionAttribute.getX(i + 2), cy = positionAttribute.getY(i + 2), cz = positionAttribute.getZ(i + 2);

      const cbx = cx - bx, cby = cy - by, cbz = cz - bz;
      const abx = ax - bx, aby = ay - by, abz = az - bz;

      const nx = aby * cbz - abz * cby;
      const ny = abz * cbx - abx * cbz;
      const nz = abx * cby - aby * cbx;

      normals[i * 3] = nx; normals[i * 3 + 1] = ny; normals[i * 3 + 2] = nz;
      normals[(i + 1) * 3] = nx; normals[(i + 1) * 3 + 1] = ny; normals[(i + 1) * 3 + 2] = nz;
      normals[(i + 2) * 3] = nx; normals[(i + 2) * 3 + 1] = ny; normals[(i + 2) * 3 + 2] = nz;
    }
  }

  normalizeNormals(normals);
  geometry[setAttrFn]('normal', new THREE.Float32BufferAttribute(normals, 3));
}

function normalizeNormals(normals) {
  for (let i = 0, il = normals.length; i < il; i += 3) {
    const x = normals[i], y = normals[i + 1], z = normals[i + 2];
    const len = Math.sqrt(x * x + y * y + z * z);
    if (len > 0) {
      normals[i] = x / len;
      normals[i + 1] = y / len;
      normals[i + 2] = z / len;
    }
    // zero-length normals (degenerate faces, e.g. r=0 caps) stay zero, matching legacy behavior
  }
}

function polar2Cartesian(lat, lng, r = 0) {
  const phi = (90 - lat) * Math.PI / 180;
  const theta = (90 - lng) * Math.PI / 180;
  return [
    r * Math.sin(phi) * Math.cos(theta), // x
    r * Math.cos(phi), // y
    r * Math.sin(phi) * Math.sin(theta) // z
  ];
}

export default ConicPolygonGeometry;
