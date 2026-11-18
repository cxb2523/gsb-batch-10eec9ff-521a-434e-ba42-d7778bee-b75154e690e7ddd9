'use strict';
// Arena = the level you draw over your real wall.
// Shapes keep all of their geometry in shape-local coordinates and are placed
// by an origin + optional rotation; physics.js exposes shapeLocalToWorld /
// shapeWorldToLocal, which drawing, editing and collision all share.
//   {t:'b', x, y, w, h, a} box/wall: x,y = center, a = rotation (radians)
//   {t:'c', x, y, r}       circle: x,y = center
//   {t:'p', x, y, a, pts}  polygon: pts = [[dx,dy], ...] relative to x,y
// Persisted to localStorage, exportable as JSON.

const W = 1280, H = 720; // logical game resolution; corner-pin maps it onto the wall

const ARENA_VERSION = 2; // v2: polygons explicitly carry local vertices (+ optional angle)
const ARENA_KINDS = { solid: true, deadly: true, bouncy: true };

const ArenaStore = {
  KEY: 'wallbrawl_arena',
  current: null,
  blank() {
    return {
      version: ARENA_VERSION,
      playerScale: 1,
      showGeo: true,
      shapes: [],
      spawns: [[W * 0.3, H * 0.35], [W * 0.7, H * 0.35]],
    };
  },
  demo() {
    const a = this.blank();
    a.shapes = [
      { t: 'b', x: W / 2, y: H - 30, w: W - 120, h: 36, a: 0 },
      { t: 'b', x: W * 0.25, y: H * 0.62, w: 260, h: 20, a: 0 },
      { t: 'b', x: W * 0.75, y: H * 0.62, w: 260, h: 20, a: 0 },
      { t: 'b', x: W * 0.5, y: H * 0.38, w: 220, h: 20, a: 0 },
      { t: 'c', x: W * 0.09, y: H * 0.45, r: 36, k: 'bouncy' },
      { t: 'c', x: W * 0.91, y: H * 0.45, r: 36, k: 'bouncy' },
      { t: 'b', x: W * 0.5, y: H - 55, w: 150, h: 14, a: 0, k: 'deadly' },
    ];
    return a;
  },
  load() {
    let parsed = null;
    try {
      const raw = localStorage.getItem(this.KEY);
      if (raw) parsed = JSON.parse(raw);
    } catch (e) { parsed = null; }
    this.current = (parsed && this.normalizeArena(parsed, false)) || this.demo();
  },
  save() {
    try { localStorage.setItem(this.KEY, JSON.stringify(this.current)); } catch (e) {}
  },
  export() {
    const blob = new Blob([JSON.stringify(this.current, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'arena.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  },
  import(file, onDone) {
    const r = new FileReader();
    r.onload = () => {
      try {
        const data = JSON.parse(r.result);
        const next = this.normalizeArena(data, true);
        if (!next) throw new Error('bad schema');
        this.current = next; // only swap after the whole file normalized cleanly
        this.save();
        if (onDone) onDone();
      } catch (e) {
        document.getElementById('hint').textContent = 'Could not read that arena file';
      }
    };
    r.readAsText(file);
  },

  // ---- normalization -------------------------------------------------------
  // Older arena files predate shape-local polygon vertices: some have no
  // origin at all, some name the vertex list differently, some store points as
  // {x,y} objects or plain numbers. Everything is folded into the canonical
  // local-coordinate form so the editor and the fight see identical geometry.
  _num(v) {
    if (typeof v === 'number') return isFinite(v) ? v : null;
    if (typeof v === 'string' && v.trim() !== '') {
      const n = Number(v);
      return isFinite(n) ? n : null;
    }
    return null;
  },
  _point(p) {
    if (Array.isArray(p)) {
      const x = this._num(p[0]), y = this._num(p[1]);
      return x !== null && y !== null ? [x, y] : null;
    }
    if (p && typeof p === 'object') {
      const x = this._num(p.x), y = this._num(p.y);
      return x !== null && y !== null ? [x, y] : null;
    }
    return null;
  },
  _type(s) {
    let t = s.t != null ? s.t : s.type;
    if (typeof t !== 'string') return null;
    t = t.toLowerCase();
    if (t === 'b' || t === 'box' || t === 'wall' || t === 'rect' || t === 'rectangle') return 'b';
    if (t === 'c' || t === 'circle') return 'c';
    if (t === 'p' || t === 'poly' || t === 'polygon') return 'p';
    return null;
  },
  _kind(s) {
    const k = s.k != null ? s.k : s.kind;
    return typeof k === 'string' && ARENA_KINDS[k] ? k : null;
  },
  _mean(pts) {
    let sx = 0, sy = 0;
    for (const [x, y] of pts) { sx += x; sy += y; }
    return [sx / pts.length, sy / pts.length];
  },
  _area(pts) {
    let a = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
    }
    return a / 2;
  },
  _polyPoints(s) {
    let raw = [s.pts, s.points, s.vertices, s.verts, s.corners, s.path, s.poly, s.polygon]
      .find(Array.isArray);
    if (!raw) return null;
    if (raw.length && typeof raw[0] === 'number') { // flat [x1,y1,x2,y2,...]
      const flat = raw;
      raw = [];
      for (let i = 0; i + 1 < flat.length; i += 2) raw.push([flat[i], flat[i + 1]]);
    }
    const pts = [];
    for (const p of raw) {
      const q = this._point(p);
      if (!q) return null; // a malformed corner makes the whole outline unreliable
      const last = pts[pts.length - 1];
      if (!last || Math.abs(last[0] - q[0]) > 1e-9 || Math.abs(last[1] - q[1]) > 1e-9) pts.push(q);
    }
    const first = pts[0], last = pts[pts.length - 1];
    if (pts.length > 1 && Math.abs(first[0] - last[0]) <= 1e-9 && Math.abs(first[1] - last[1]) <= 1e-9) pts.pop();
    return pts;
  },
  _polygon(s, legacy) {
    const pts = this._polyPoints(s);
    if (!pts || pts.length < 3) return null;
    if (Math.abs(this._area(pts)) < 1e-9) return null; // degenerate / collinear

    let x = this._num(s.x), y = this._num(s.y);
    let local = pts;
    if (x === null || y === null) {
      // Legacy file without a local origin: treat the stored points as world
      // coordinates and rebase them onto their centroid.
      [x, y] = this._mean(pts);
      local = pts.map(([px, py]) => [px - x, py - y]);
    } else if (legacy) {
      // Pre-v2 files did not promise canonical local vertices. A canonical
      // outline centres on (0,0) in local space; a legacy one may still hold
      // absolute world points, which centre on the shape's own (x,y) instead.
      // Rebase only when the vertex cloud is strictly closer to the shape
      // origin than to local zero (a symmetric polygon's local centroid is at
      // (0,0) too, so ties must keep "already local").
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const [px, py] of pts) {
        if (px < minX) minX = px; if (px > maxX) maxX = px;
        if (py < minY) minY = py; if (py > maxY) maxY = py;
      }
      const extent = Math.max(maxX - minX, maxY - minY);
      const tol = Math.max(1e-9, extent * 1e-9);
      const [mx, my] = this._mean(pts);
      const nearShape = Math.hypot(mx - x, my - y) + tol < Math.hypot(mx, my);
      if (nearShape) local = pts.map(([px, py]) => [px - x, py - y]);
    }

    const out = { t: 'p', x, y, a: this._num(s.a) || 0, pts: local };
    const k = this._kind(s);
    if (k) out.k = k;
    return out;
  },
  _shape(s, legacy) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
    const t = this._type(s);
    if (t === 'p') return this._polygon(s, legacy);
    if (t === 'b') {
      const x = this._num(s.x), y = this._num(s.y);
      let w = this._num(s.w), h = this._num(s.h);
      if (x === null || y === null || w === null || h === null) return null;
      w = Math.abs(w); h = Math.abs(h);
      if (w <= 0 || h <= 0) return null;
      const out = { t: 'b', x, y, w, h, a: this._num(s.a) || 0 };
      const k = this._kind(s);
      if (k) out.k = k;
      return out;
    }
    if (t === 'c') {
      const x = this._num(s.x), y = this._num(s.y);
      const r = this._num(s.r);
      if (x === null || y === null || r === null || Math.abs(r) <= 0) return null;
      const out = { t: 'c', x, y, r: Math.abs(r) };
      const k = this._kind(s);
      if (k) out.k = k;
      return out;
    }
    return null;
  },
  _spawns(list, fallback) {
    return [0, 1].map(i => this._point(Array.isArray(list) ? list[i] : null) || fallback[i].slice());
  },
  // Returns a fully normalized arena, or null when the payload cannot be used.
  // strict=true (import) requires both arrays and at least one surviving shape
  // when shapes were supplied, so a broken file never wipes the current arena.
  normalizeArena(data, strict) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    const hasShapes = Array.isArray(data.shapes);
    const hasSpawns = Array.isArray(data.spawns);
    if (strict && (!hasShapes || !hasSpawns)) return null;
    // A lenient load (localStorage) still needs *something* arena-shaped in it;
    // otherwise the saved blob is junk and the caller should fall back to demo.
    if (!strict && !hasShapes && !hasSpawns && this._num(data.version) === null) return null;

    const out = this.blank();
    const legacy = this._num(data.version) === null || this._num(data.version) < ARENA_VERSION;
    const scale = this._num(data.playerScale);
    if (scale !== null && scale > 0 && scale < 100) out.playerScale = scale;
    if (typeof data.showGeo === 'boolean') out.showGeo = data.showGeo;

    const shapes = [];
    if (hasShapes) {
      for (const s of data.shapes) {
        const n = this._shape(s, legacy);
        if (n) shapes.push(n);
      }
    }
    if (strict && hasShapes && data.shapes.length > 0 && shapes.length === 0) return null;
    out.shapes = shapes;
    out.spawns = this._spawns(hasSpawns ? data.spawns : null, out.spawns);
    return out;
  },
};
