'use strict';
// Minimal collision layer: circles (players, crates, bullets-as-points)
// against the arena's rotated boxes, circles, and polygons.
//
// Every shape stores its geometry in shape-local coordinates and is placed by
// an origin plus an optional rotation. shapeLocalToWorld / shapeWorldToLocal
// are the single transform used by drawing, editing and collision, so the
// outline you see and the outline the physics uses can never drift apart.

function shapeAngle(s) {
  return s.t === 'c' ? 0 : (s.a || 0);
}

function shapeLocalToWorld(s, lx, ly, out) {
  const a = shapeAngle(s);
  const ca = Math.cos(a), sa = Math.sin(a);
  const x = s.x + lx * ca - ly * sa;
  const y = s.y + lx * sa + ly * ca;
  if (out) { out.x = x; out.y = y; return out; }
  return { x, y };
}

function shapeWorldToLocal(s, wx, wy, out) {
  const a = shapeAngle(s);
  const ca = Math.cos(a), sa = Math.sin(a);
  const dx = wx - s.x, dy = wy - s.y;
  const x = dx * ca + dy * sa;
  const y = -dx * sa + dy * ca;
  if (out) { out.x = x; out.y = y; return out; }
  return { x, y };
}

function shapeLocalDirToWorld(s, nx, ny, out) {
  const a = shapeAngle(s);
  const ca = Math.cos(a), sa = Math.sin(a);
  const x = nx * ca - ny * sa;
  const y = nx * sa + ny * ca;
  if (out) { out.x = x; out.y = y; return out; }
  return { x, y };
}

// World-space outline vertices for polygons and boxes (editor handles,
// hit-testing helpers). Circles have no vertices.
function shapeWorldVertices(s) {
  if (s.t === 'p') {
    return (s.pts || []).map(([x, y]) => {
      const w = shapeLocalToWorld(s, x, y);
      return [w.x, w.y];
    });
  }
  if (s.t === 'b') {
    const hw = s.w / 2, hh = s.h / 2;
    return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) => {
      const w = shapeLocalToWorld(s, x, y);
      return [w.x, w.y];
    });
  }
  return null;
}

// Interior test in shape-local space using the nonzero winding rule — the same
// rule canvas's default fill() uses, so the area the player is kept out of is
// exactly the area that looks filled, concave outlines included.
function pointInPolygonLocal(pts, x, y) {
  let wn = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const x0 = pts[j][0], y0 = pts[j][1]; // edge start
    const x1 = pts[i][0], y1 = pts[i][1]; // edge end
    const isLeft = (x1 - x0) * (y - y0) - (x - x0) * (y1 - y0);
    if (y0 <= y) {
      if (y1 > y && isLeft > 0) wn++;        // upward crossing, point left of edge
    } else if (y1 <= y && isLeft < 0) {
      wn--;                                  // downward crossing, point right of edge
    }
  }
  return wn !== 0;
}

// Closest point on the polygon outline, in local space. Also reports the edge
// so callers can recover an outward normal when the centre sits exactly on it.
function closestOnPolygonLocal(pts, x, y) {
  let bestD2 = Infinity, bx = 0, by = 0, edge = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const x1 = pts[j][0], y1 = pts[j][1];
    const x2 = pts[i][0], y2 = pts[i][1];
    const ex = x1 - x2, ey = y1 - y2;
    const t = clamp(((x - x2) * ex + (y - y2) * ey) / (ex * ex + ey * ey || 1), 0, 1);
    const px = x2 + ex * t, py = y2 + ey * t;
    const d2 = (x - px) * (x - px) + (y - py) * (y - py);
    if (d2 < bestD2) { bestD2 = d2; bx = px; by = py; edge = i; }
  }
  return { d2: bestD2, x: bx, y: by, edge };
}

// Outward normal of edge (pts[j] -> pts[i]), independent of the outline's
// winding: probe just off the edge midpoint and point away from the interior.
function polyEdgeOutwardNormal(pts, i) {
  const j = (i + pts.length - 1) % pts.length;
  const ax = pts[j][0], ay = pts[j][1];
  const bx = pts[i][0], by = pts[i][1];
  const dx = bx - ax, dy = by - ay;
  const len = Math.hypot(dx, dy) || 1;
  let nx = dy / len, ny = -dx / len;
  const mx = (ax + bx) / 2, my = (ay + by) / 2;
  const probe = Math.max(1e-4, len * 1e-4);
  if (pointInPolygonLocal(pts, mx + nx * probe, my + ny * probe)) { nx = -nx; ny = -ny; }
  return { nx, ny };
}

// Circle vs polygon, both in shape-local coordinates.
// - Centre outside: the nearest point on the outline gives the push direction.
// - Centre inside: try the perpendicular exit through each edge's outward
//   side and take the shortest one that actually lands clear of the outline.
//   This keeps the push direction a real outline normal, so concave shapes
//   never eject bodies through a wall they should have hit.
const POLY_EPS = 1e-6;

function collideCirclePolyLocal(cx, cy, cr, pts) {
  if (!pts || pts.length < 3) return null;
  const inside = pointInPolygonLocal(pts, cx, cy);
  const near = closestOnPolygonLocal(pts, cx, cy);
  const dNear = Math.sqrt(near.d2);

  if (!inside) {
    if (dNear >= cr - POLY_EPS) return null; // no overlap
    let nx, ny;
    if (dNear <= POLY_EPS) {
      const n = polyEdgeOutwardNormal(pts, near.edge);
      nx = n.nx; ny = n.ny;
    } else {
      nx = (cx - near.x) / dNear; ny = (cy - near.y) / dNear;
    }
    // If stepping straight out lands in another fold of a concave outline,
    // keep going along the same normal until the circle is genuinely clear.
    let step = cr - dNear;
    for (let k = 0; k < 6; k++) {
      const tx = cx + nx * step, ty = cy + ny * step;
      const clear = !pointInPolygonLocal(pts, tx, ty) &&
        Math.sqrt(closestOnPolygonLocal(pts, tx, ty).d2) >= cr - POLY_EPS;
      if (clear) return { nx, ny, depth: step };
      step += cr * 0.5;
    }
    return { nx, ny, depth: cr - dNear };
  }

  // Centre inside: candidate exit through every edge.
  let best = null;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + pts.length - 1) % pts.length;
    const ax = pts[j][0], ay = pts[j][1];
    const bx = pts[i][0], by = pts[i][1];
    const ex = bx - ax, ey = by - ay;
    const len = Math.hypot(ex, ey);
    if (len <= POLY_EPS) continue;
    // unit normal, flipped to point away from the interior
    let nx = ey / len, ny = -ex / len;
    const mx = (ax + bx) / 2, my = (ay + by) / 2;
    const probe = Math.max(1e-4, len * 1e-4);
    if (pointInPolygonLocal(pts, mx + nx * probe, my + ny * probe)) { nx = -nx; ny = -ny; }

    const signed = (cx - ax) * nx + (cy - ay) * ny; // < 0 while centre is inside
    const step = cr - signed;
    if (step <= 0) continue;
    const tx = cx + nx * step, ty = cy + ny * step;
    if (pointInPolygonLocal(pts, tx, ty)) continue;      // landed in another fold
    const check = closestOnPolygonLocal(pts, tx, ty);
    if (Math.sqrt(check.d2) < cr - POLY_EPS) continue;   // still overlapping a wall
    if (!best || step < best.depth) best = { nx, ny, depth: step };
  }
  if (best) return best;

  // Degenerate/very thin outline: fall back to stepping out through the
  // nearest boundary point until the circle is clear.
  let x = cx, y = cy;
  for (let iter = 0; iter < 16; iter++) {
    const h = closestOnPolygonLocal(pts, x, y);
    const d = Math.sqrt(h.d2);
    if (!pointInPolygonLocal(pts, x, y) && d >= cr - POLY_EPS) break;
    let ux, uy;
    if (d > POLY_EPS) { ux = (h.x - x) / d; uy = (h.y - y) / d; }
    else { const n = polyEdgeOutwardNormal(pts, h.edge); ux = n.nx; uy = n.ny; }
    x += ux * (d + cr);
    y += uy * (d + cr);
  }
  const dx = x - cx, dy = y - cy;
  const dist = Math.hypot(dx, dy);
  if (dist <= POLY_EPS) return null;
  return { nx: dx / dist, ny: dy / dist, depth: dist };
}

function collideCirclePoly(cx, cy, cr, s) {
  const l = shapeWorldToLocal(s, cx, cy);
  const hit = collideCirclePolyLocal(l.x, l.y, cr, s.pts);
  if (!hit) return null;
  const n = shapeLocalDirToWorld(s, hit.nx, hit.ny);
  return { nx: n.x, ny: n.y, depth: hit.depth };
}

function collideCircleShape(cx, cy, cr, s) {
  if (s.t === 'p') return collideCirclePoly(cx, cy, cr, s);
  if (s.t === 'c') {
    const dx = cx - s.x, dy = cy - s.y;
    const d = Math.hypot(dx, dy), rr = cr + s.r;
    if (d === 0) return { nx: 0, ny: -1, depth: rr };
    if (d >= rr) return null;
    return { nx: dx / d, ny: dy / d, depth: rr - d };
  }
  // rotated box: same local-frame transform the editor and renderer use
  const l = shapeWorldToLocal(s, cx, cy);
  const hw = s.w / 2, hh = s.h / 2;
  const qx = clamp(l.x, -hw, hw), qy = clamp(l.y, -hh, hh);
  const dx = l.x - qx, dy = l.y - qy;
  const d = Math.hypot(dx, dy);
  let nlx, nly, depth;
  if (d > 0) {
    if (d >= cr) return null;
    nlx = dx / d; nly = dy / d; depth = cr - d;
  } else {
    // center is inside the box: push out along the shallowest axis
    const px = hw - Math.abs(l.x), py = hh - Math.abs(l.y);
    if (px < py) { nlx = l.x >= 0 ? 1 : -1; nly = 0; depth = px + cr; }
    else { nlx = 0; nly = l.y >= 0 ? 1 : -1; depth = py + cr; }
  }
  const n = shapeLocalDirToWorld(s, nlx, nly);
  return { nx: n.x, ny: n.y, depth };
}

function pointInShape(x, y, s, pad = 0) {
  return !!collideCircleShape(x, y, pad + 0.1, s);
}

// Pushes body {x,y,r,vx,vy} out of all shapes. Returns true if standing on ground.
// Bouncy shapes (s.k === 'bouncy') reflect velocity instead of absorbing it.
// onHit(shape, hit, vn) fires per contact so callers can react (e.g. deadly shapes).
function resolveBody(b, shapes, onHit) {
  let ground = false;
  for (const s of shapes) {
    const hit = collideCircleShape(b.x, b.y, b.r, s);
    if (!hit) continue;
    b.x += hit.nx * hit.depth;
    b.y += hit.ny * hit.depth;
    const vn = b.vx * hit.nx + b.vy * hit.ny;
    if (vn < 0) {
      const e = s.k === 'bouncy' ? 0.85 : 0;
      b.vx -= (1 + e) * vn * hit.nx;
      b.vy -= (1 + e) * vn * hit.ny;
    }
    if (hit.ny < -0.55 && (s.k !== 'bouncy' || Math.abs(vn) < 60)) ground = true;
    if (onHit) onHit(s, hit, vn);
  }
  return ground;
}
