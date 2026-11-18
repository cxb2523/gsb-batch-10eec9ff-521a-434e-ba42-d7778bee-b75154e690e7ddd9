#!/usr/bin/env node
// tests/selection-transform.test.js
//
// Locally runnable verification for multi-selection transforms:
//   1. union-bounds based handles + proportional scaling of every selected shape
//   2. locked shapes (via VexelSceneNode.locked) are excluded from scaling
//   3. exactly one undo entry per drag, undo restores all geometry
//
// Run with: node tests/selection-transform.test.js

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Minimal harness: load the browser-style source files into one vm context.
// The files rely on shared top-level lexical bindings (not ES modules), so a
// single context reproduces the browser's <script> ordering semantics.
// ---------------------------------------------------------------------------

function loadRuntime() {
    const sandbox = { console };
    const context = vm.createContext(sandbox);

    vm.runInContext('globalThis.window = globalThis;', context);

    const files = [
        'src/utils/math.js',
        'src/core/scene-graph.js',
        'src/tools/selection-geometry.js',
        'src/utils/history.js',
        'src/core/vexel.js',
        'src/tools/select.js'
    ];

    for (const rel of files) {
        const code = fs.readFileSync(path.join(ROOT, rel), 'utf8');
        vm.runInContext(code, context, { filename: rel });
    }

    const runtime = vm.runInContext(`({
        VexelSelectionGeometry: VexelSelectionGeometry,
        VexelSceneGraph: VexelSceneGraph,
        VexelSceneNode: VexelSceneNode,
        VexelHistory: VexelHistory,
        Vexel: Vexel,
        VexelRectangle: VexelRectangle,
        VexelEllipse: VexelEllipse,
        VexelPath: VexelPath,
        VexelText: VexelText,
        VexelGroup: VexelGroup,
        VexelSelectTool: VexelSelectTool
    })`, context);

    return runtime;
}

const rt = loadRuntime();

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

let passCount = 0;
let failCount = 0;
const failures = [];

function assert(condition, message) {
    if (condition) {
        passCount++;
    } else {
        failCount++;
        failures.push(message);
        console.error(`  FAIL: ${message}`);
    }
}

function approx(actual, expected, epsilon, message) {
    const ok = Math.abs(actual - expected) <= (epsilon === undefined ? 1e-9 : epsilon);
    assert(ok, `${message} (expected ~${expected}, got ${actual})`);
}

function approxBounds(actual, expected, message, epsilon) {
    const eps = epsilon === undefined ? 1e-9 : epsilon;
    approx(actual.x, expected.x, eps, `${message}: x`);
    approx(actual.y, expected.y, eps, `${message}: y`);
    approx(actual.width, expected.width, eps, `${message}: width`);
    approx(actual.height, expected.height, eps, `${message}: height`);
}

function run(name, fn) {
    console.log(`\n• ${name}`);
    try {
        fn();
    } catch (err) {
        failCount++;
        failures.push(`${name}: threw ${err && err.stack ? err.stack : err}`);
        console.error(`  FAIL: threw ${err && err.stack ? err.stack : err}`);
    }
}

// ---------------------------------------------------------------------------
// Runtime helpers
// ---------------------------------------------------------------------------

function createVexel(shapes) {
    // Bypass the DOM-heavy constructor but keep every prototype method.
    const v = Object.create(rt.Vexel.prototype);

    v.shapes = shapes.slice();
    v.selectedShapes = shapes.slice();
    v.viewport = { x: 0, y: 0, zoom: 1, rotation: 0 };
    v.history = { undo: [], redo: [], maxSteps: 100 };
    v.sceneGraph = new rt.VexelSceneGraph();
    v._shapeNodeIds = new Map();
    v.dirty = false;
    v.snapEnabled = false;
    v.snapSize = 10;
    v.container = {
        style: {},
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
        addEventListener: () => {},
        removeEventListener: () => {}
    };

    return v;
}

function createTool(vexel) {
    const tool = new rt.VexelSelectTool(vexel);
    tool.active = true;
    return tool;
}

function mouseEvent(x, y, options) {
    return Object.assign({
        clientX: x,
        clientY: y,
        button: 0,
        shiftKey: false,
        metaKey: false,
        ctrlKey: false
    }, options || {});
}

function rect(x, y, width, height, options) {
    return new rt.VexelRectangle(x, y, width, height, options || {});
}

function snapshotGeometry(shape) {
    const b = shape.getBounds();
    return {
        bounds: { x: b.x, y: b.y, width: b.width, height: b.height },
        x: shape.x,
        y: shape.y,
        width: shape.width,
        height: shape.height,
        scaleX: shape.scaleX,
        scaleY: shape.scaleY
    };
}

function cloneGeom(g) {
    return JSON.parse(JSON.stringify(g));
}

// Simulates a complete drag of a handle at the union bounds in canvas space.
function dragHandle(tool, vexel, handle, dx, dy) {
    const geometry = rt.VexelSelectionGeometry;
    const bounds = geometry.selectionBounds(vexel.selectedShapes);
    const handles = geometry.handlePositions(bounds);
    const start = handles[handle];

    const startScreen = {
        x: start.x * vexel.viewport.zoom + vexel.viewport.x,
        y: start.y * vexel.viewport.zoom + vexel.viewport.y
    };

    tool._handleMouseDown(mouseEvent(startScreen.x, startScreen.y));
    tool._handleMouseMove(mouseEvent(
        startScreen.x + dx * vexel.viewport.zoom,
        startScreen.y + dy * vexel.viewport.zoom
    ));
    tool._handleMouseUp(mouseEvent(
        startScreen.x + dx * vexel.viewport.zoom,
        startScreen.y + dy * vexel.viewport.zoom
    ));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

run('selection bounds are the union of every selected shape', () => {
    const a = rect(100, 100, 100, 50);
    const b = rect(300, 200, 50, 100);
    const c = rect(200, 350, 80, 80);
    const vexel = createVexel([a, b, c]);
    const tool = createTool(vexel);

    const union = tool.getSelectionBounds();

    approxBounds(union, { x: 100, y: 100, width: 250, height: 330 }, 'union bounds');

    // Handles must be derived from the union, not from individual boxes.
    const handles = rt.VexelSelectionGeometry.handlePositions(union);
    approx(handles.se.x, 350, 1e-9, 'south-east handle x');
    approx(handles.se.y, 430, 1e-9, 'south-east handle y');
    approx(handles.nw.x, 100, 1e-9, 'north-west handle x');
});

run('dragging a corner scales every shape by the same ratio about the union origin', () => {
    const a = rect(100, 100, 100, 50);
    const b = rect(300, 200, 50, 100);
    const c = rect(200, 350, 80, 80);
    const vexel = createVexel([a, b, c]);
    const tool = createTool(vexel);

    const before = { union: tool.getSelectionBounds() };
    before.a = snapshotGeometry(a);
    before.b = snapshotGeometry(b);
    before.c = snapshotGeometry(c);

    dragHandle(tool, vexel, 'se', 125, 165); // union 250x330 -> 375x495 (x1.5)

    const afterUnion = tool.getSelectionBounds();
    approxBounds(afterUnion, { x: 100, y: 100, width: 375, height: 495 }, 'scaled union');

    const ratioX = afterUnion.width / before.union.width;
    const ratioY = afterUnion.height / before.union.height;
    approx(ratioX, 1.5, 1e-9, 'union x ratio');
    approx(ratioY, 1.5, 1e-9, 'union y ratio');

    for (const [name, shape] of Object.entries({ a, b, c })) {
        const orig = before[name].bounds;
        const now = shape.getBounds();

        approx(now.width, orig.width * ratioX, 1e-9, `${name} scales width by the union ratio`);
        approx(now.height, orig.height * ratioY, 1e-9, `${name} scales height by the union ratio`);

        const relBefore = {
            x: (orig.x - before.union.x) / before.union.width,
            y: (orig.y - before.union.y) / before.union.height
        };
        const relAfter = {
            x: (now.x - afterUnion.x) / afterUnion.width,
            y: (now.y - afterUnion.y) / afterUnion.height
        };

        approx(relAfter.x, relBefore.x, 1e-9, `${name} keeps its relative x in the union`);
        approx(relAfter.y, relBefore.y, 1e-9, `${name} keeps its relative y in the union`);
    }

    // Selection and z-order must survive the transform.
    assert(vexel.shapes.length === 3 && vexel.shapes[0] === a && vexel.shapes[1] === b && vexel.shapes[2] === c,
        'shape z-order is preserved');
    assert(vexel.selectedShapes.length === 3 &&
        vexel.selectedShapes.includes(a) && vexel.selectedShapes.includes(b) && vexel.selectedShapes.includes(c),
        'selection state is preserved');
});

run('scaling is correct under a zoomed and panned viewport without touching viewport state', () => {
    const a = rect(100, 100, 100, 50);
    const b = rect(300, 200, 50, 100);
    const vexel = createVexel([a, b]);
    vexel.viewport = { x: 37, y: -19, zoom: 2, rotation: 0 };
    const tool = createTool(vexel);

    const viewportBefore = { ...vexel.viewport };
    const before = {
        union: tool.getSelectionBounds(),
        a: snapshotGeometry(a),
        b: snapshotGeometry(b)
    };

    // Screen-space drag of (+80, +120) must translate to (+40, +60) canvas units.
    dragHandle(tool, vexel, 'se', 20, 30);

    const after = tool.getSelectionBounds();
    approx(after.width, before.union.width + 20, 1e-9, 'canvas-space dx is screen dx / zoom');
    approx(after.height, before.union.height + 30, 1e-9, 'canvas-space dy is screen dy / zoom');

    const ratioX = after.width / before.union.width;
    const ratioY = after.height / before.union.height;
    approx(a.getBounds().width, before.a.bounds.width * ratioX, 1e-9, 'zoomed shape a scales proportionally');
    approx(b.getBounds().width, before.b.bounds.width * ratioX, 1e-9, 'zoomed shape b scales proportionally');

    assert(vexel.viewport.x === viewportBefore.x &&
        vexel.viewport.y === viewportBefore.y &&
        vexel.viewport.zoom === viewportBefore.zoom,
        'resize does not mutate viewport pan/zoom');
});

run('locked scene-graph shapes keep their geometry while the rest scale about the union', () => {
    const a = rect(100, 100, 100, 50);
    const locked = rect(300, 200, 50, 100);
    const c = rect(200, 350, 80, 80);

    const vexel = createVexel([a, locked, c]);

    // Lock state only exists on the scene-graph node.
    assert(locked.locked === undefined, 'shape object itself has no locked field');
    const node = vexel.attachShapeToSceneNode(locked, 'node-locked', { locked: true });
    assert(node && node.locked === true, 'scene node is locked');
    assert(vexel.isShapeLocked(locked) === true, 'lock state resolves through the scene node');
    assert(vexel.isShapeLocked(a) === false, 'unassociated shapes resolve as unlocked');

    const tool = createTool(vexel);

    const unionBefore = tool.getSelectionBounds();
    const lockedBefore = cloneGeom(snapshotGeometry(locked));
    const aBefore = cloneGeom(snapshotGeometry(a));
    const cBefore = cloneGeom(snapshotGeometry(c));

    dragHandle(tool, vexel, 'se', unionBefore.width * 0.5, unionBefore.height * 0.5);

    const ratioX = 1.5;
    const ratioY = 1.5;

    // The visible frame is recomputed from actual geometry, so it no longer
    // matches the naive scaled union while a locked member stays put.
    const unionAfter = tool.getSelectionBounds();
    const expectedUnion = {
        x: unionBefore.x,
        y: unionBefore.y,
        width: Math.max(
            a.getBounds().x + a.getBounds().width,
            c.getBounds().x + c.getBounds().width,
            locked.getBounds().x + locked.getBounds().width
        ) - unionBefore.x,
        height: Math.max(
            a.getBounds().y + a.getBounds().height,
            c.getBounds().y + c.getBounds().height,
            locked.getBounds().y + locked.getBounds().height
        ) - unionBefore.y
    };
    approxBounds(unionAfter, expectedUnion, 'frame follows the live union of actual geometry');

    const lockedAfter = snapshotGeometry(locked);
    approxBounds({ x: lockedAfter.bounds.x, y: lockedAfter.bounds.y, width: lockedAfter.bounds.width, height: lockedAfter.bounds.height },
        { x: lockedBefore.bounds.x, y: lockedBefore.bounds.y, width: lockedBefore.bounds.width, height: lockedBefore.bounds.height },
        'locked shape geometry is untouched');

    approx(a.getBounds().width, aBefore.bounds.width * ratioX, 1e-9, 'unlocked shape a scales by the union ratio');
    approx(a.getBounds().height, aBefore.bounds.height * ratioY, 1e-9, 'unlocked shape a scales by the union ratio (height)');
    approx(c.getBounds().width, cBefore.bounds.width * ratioX, 1e-9, 'unlocked shape c scales by the union ratio');
    approx(c.getBounds().height, cBefore.bounds.height * ratioY, 1e-9, 'unlocked shape c scales by the union ratio (height)');

    // Positions move relative to the union anchor by the same ratio.
    approx(a.getBounds().x, unionBefore.x + (aBefore.bounds.x - unionBefore.x) * ratioX, 1e-9,
        'unlocked shape a anchors relative to the union');
    approx(c.getBounds().y, unionBefore.y + (cBefore.bounds.y - unionBefore.y) * ratioY, 1e-9,
        'unlocked shape c anchors relative to the union');

    // Locked shape stays selected and in the same layer position.
    assert(vexel.selectedShapes.includes(locked), 'locked shape remains selected');
    assert(vexel.shapes.indexOf(locked) === 1, 'locked shape keeps its z-order index');
});

run('a shape with a stray locked flag but no scene node is explicitly treated as unlocked', () => {
    const shape = rect(10, 10, 20, 20);
    shape.locked = true; // not part of the shape model, must not drive lock semantics
    const vexel = createVexel([shape]);

    assert(vexel.getSceneNodeForShape(shape) === null, 'no scene node association exists');
    assert(vexel.isShapeLocked(shape) === false,
        'without an association the shape is explicitly unlocked rather than silently locked');
});

run('one drag creates exactly one undo entry and undo restores all geometry', () => {
    const a = rect(100, 100, 100, 50);
    const b = rect(300, 200, 50, 100);
    const c = rect(200, 350, 80, 80);
    const vexel = createVexel([a, b, c]);
    const tool = createTool(vexel);

    const undoBefore = vexel.history.undo.length;
    const before = {
        union: tool.getSelectionBounds(),
        a: cloneGeom(snapshotGeometry(a)),
        b: cloneGeom(snapshotGeometry(b)),
        c: cloneGeom(snapshotGeometry(c))
    };

    const geometry = rt.VexelSelectionGeometry;
    const bounds = tool.getSelectionBounds();
    const start = geometry.handlePositions(bounds).se;
    const startScreen = { x: start.x + vexel.viewport.x, y: start.y + vexel.viewport.y };

    tool._handleMouseDown(mouseEvent(startScreen.x, startScreen.y));
    for (let step = 1; step <= 8; step++) {
        tool._handleMouseMove(mouseEvent(startScreen.x + step * 10, startScreen.y + step * 12));
        assert(vexel.history.undo.length === undoBefore,
            `intermediate drag step ${step} does not write history`);
    }
    tool._handleMouseUp(mouseEvent(startScreen.x + 80, startScreen.y + 96));

    assert(vexel.history.undo.length === undoBefore + 1,
        'exactly one undo entry is recorded for the whole drag');
    assert(vexel.history.undo[undoBefore].type === 'transform-shapes',
        'the undo entry is a batched multi-shape transform');

    const scaledUnion = tool.getSelectionBounds();
    const ratioX = scaledUnion.width / before.union.width;
    const ratioY = scaledUnion.height / before.union.height;

    vexel.undo();

    const afterUndo = {
        a: cloneGeom(snapshotGeometry(a)),
        b: cloneGeom(snapshotGeometry(b)),
        c: cloneGeom(snapshotGeometry(c))
    };

    for (const key of ['a', 'b', 'c']) {
        approxBounds(afterUndo[key].bounds, before[key].bounds, `undo restores ${key} bounds`);
        approx(afterUndo[key].x, before[key].x, 1e-9, `undo restores ${key}.x`);
        approx(afterUndo[key].y, before[key].y, 1e-9, `undo restores ${key}.y`);
        approx(afterUndo[key].width, before[key].width, 1e-9, `undo restores ${key}.width`);
        approx(afterUndo[key].height, before[key].height, 1e-9, `undo restores ${key}.height`);
    }

    // Redo must be able to re-apply the scaled geometry.
    vexel.redo();
    approxBounds(a.getBounds(), {
        x: before.union.x + (before.a.bounds.x - before.union.x) * ratioX,
        y: before.union.y + (before.a.bounds.y - before.union.y) * ratioY,
        width: before.a.bounds.width * ratioX,
        height: before.a.bounds.height * ratioY
    }, 'redo re-applies the scaled geometry');
});

run('locked-only selections never change geometry or history', () => {
    const a = rect(50, 50, 40, 40);
    const b = rect(150, 120, 60, 30);
    const vexel = createVexel([a, b]);
    vexel.attachShapeToSceneNode(a, 'node-a', { locked: true });
    vexel.attachShapeToSceneNode(b, 'node-b', { locked: true });

    const tool = createTool(vexel);
    const before = { a: cloneGeom(snapshotGeometry(a)), b: cloneGeom(snapshotGeometry(b)) };
    const undoBefore = vexel.history.undo.length;

    dragHandle(tool, vexel, 'se', 100, 100);

    approxBounds(a.getBounds(), before.a.bounds, 'locked a untouched');
    approxBounds(b.getBounds(), before.b.bounds, 'locked b untouched');
    assert(vexel.history.undo.length === undoBefore, 'no history entry for an all-locked selection');
});

run('single-shape resize keeps the previous behaviour', () => {
    const a = rect(100, 100, 100, 50);
    const vexel = createVexel([a]);
    const tool = createTool(vexel);

    dragHandle(tool, vexel, 'se', 20, 10);

    approxBounds(a.getBounds(), { x: 100, y: 100, width: 120, height: 60 }, 'single shape resized');
    assert(vexel.history.undo.length === 1, 'one undo entry for a single shape resize');
});

run('ellipse geometry is resized through its radii and restored by undo', () => {
    const e = new rt.VexelEllipse(200, 200, 40, 20);
    const r = rect(300, 300, 50, 50);
    const vexel = createVexel([e, r]);
    const tool = createTool(vexel);

    const beforeEllipse = { x: e.x, y: e.y, rx: e.radiusX, ry: e.radiusY };

    dragHandle(tool, vexel, 'se', 100, 100);
    assert(e.radiusX !== beforeEllipse.rx, 'ellipse radiusX changed after scaling');
    assert(e.radiusY !== beforeEllipse.ry, 'ellipse radiusY changed after scaling');

    vexel.undo();

    approx(e.x, beforeEllipse.x, 1e-9, 'ellipse x restored');
    approx(e.y, beforeEllipse.y, 1e-9, 'ellipse y restored');
    approx(e.radiusX, beforeEllipse.rx, 1e-9, 'ellipse radiusX restored');
    approx(e.radiusY, beforeEllipse.ry, 1e-9, 'ellipse radiusY restored');
});

run('selection frame updates live during the drag, before mouse-up', () => {
    const a = rect(100, 100, 100, 50);
    const b = rect(300, 200, 50, 100);
    const vexel = createVexel([a, b]);
    const tool = createTool(vexel);

    const geometry = rt.VexelSelectionGeometry;
    const union = tool.getSelectionBounds();
    const start = geometry.handlePositions(union).se;

    tool._handleMouseDown(mouseEvent(start.x, start.y));
    tool._handleMouseMove(mouseEvent(start.x + 25, start.y + 10));

    const midUnion = tool.getSelectionBounds();
    approx(midUnion.width, union.width + 25, 1e-9, 'frame width tracks the pointer mid-drag');
    approx(midUnion.height, union.height + 10, 1e-9, 'frame height tracks the pointer mid-drag');

    // Handles are recomputed from the live union, not cached at drag start.
    const midHandles = geometry.handlePositions(midUnion);
    approx(midHandles.se.x, union.x + union.width + 25, 1e-9, 'se handle follows the live union x');
    approx(midHandles.se.y, union.y + union.height + 10, 1e-9, 'se handle follows the live union y');

    tool._handleMouseUp(mouseEvent(start.x + 25, start.y + 10));
});

run('dragging a multi-selection records a single move entry and undo restores positions', () => {
    const a = rect(100, 100, 100, 50);
    const b = rect(300, 200, 50, 100);
    const vexel = createVexel([a, b]);
    const tool = createTool(vexel);

    const before = { a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y } };
    const undoBefore = vexel.history.undo.length;

    // Press inside shape a, drag, release.
    tool._handleMouseDown(mouseEvent(150, 125));
    tool._handleMouseMove(mouseEvent(190, 165));
    tool._handleMouseMove(mouseEvent(210, 185));
    assert(vexel.history.undo.length === undoBefore, 'drag motion writes no intermediate history');
    tool._handleMouseUp(mouseEvent(210, 185));

    assert(vexel.history.undo.length === undoBefore + 1, 'one move entry for the whole drag');
    approx(a.x, before.a.x + 60, 1e-9, 'shape a moved by the drag delta');
    approx(b.x, before.b.x + 60, 1e-9, 'shape b moved by the drag delta');

    vexel.undo();
    approx(a.x, before.a.x, 1e-9, 'undo restores shape a x');
    approx(a.y, before.a.y, 1e-9, 'undo restores shape a y');
    approx(b.x, before.b.x, 1e-9, 'undo restores shape b x');
    approx(b.y, before.b.y, 1e-9, 'undo restores shape b y');
});

run('every handle direction scales the union proportionally', () => {
    const cases = [
        { handle: 'nw', dx: -40, dy: -30 },
        { handle: 'ne', dx: 40, dy: -30 },
        { handle: 'sw', dx: -40, dy: 30 },
        { handle: 'n', dx: 0, dy: -30 },
        { handle: 's', dx: 0, dy: 30 },
        { handle: 'w', dx: -40, dy: 0 },
        { handle: 'e', dx: 40, dy: 0 }
    ];

    for (const c of cases) {
        const a = rect(100, 100, 100, 50);
        const b = rect(300, 200, 50, 100);
        const vexel = createVexel([a, b]);
        const tool = createTool(vexel);

        const unionBefore = tool.getSelectionBounds();
        const aBefore = snapshotGeometry(a);
        const bBefore = snapshotGeometry(b);

        dragHandle(tool, vexel, c.handle, c.dx, c.dy);

        const unionAfter = tool.getSelectionBounds();
        const ratioX = unionAfter.width / unionBefore.width;
        const ratioY = unionAfter.height / unionBefore.height;

        const expectedWidth = (c.handle === 'n' || c.handle === 's')
            ? unionBefore.width
            : unionBefore.width + Math.abs(c.dx);
        const expectedHeight = (c.handle === 'e' || c.handle === 'w')
            ? unionBefore.height
            : unionBefore.height + Math.abs(c.dy);

        approx(unionAfter.width, expectedWidth, 1e-9, `${c.handle}: union width`);
        approx(unionAfter.height, expectedHeight, 1e-9, `${c.handle}: union height`);

        approx(a.getBounds().width, aBefore.bounds.width * ratioX, 1e-9, `${c.handle}: shape a width ratio`);
        approx(a.getBounds().height, aBefore.bounds.height * ratioY, 1e-9, `${c.handle}: shape a height ratio`);
        approx(b.getBounds().width, bBefore.bounds.width * ratioX, 1e-9, `${c.handle}: shape b width ratio`);
        approx(b.getBounds().height, bBefore.bounds.height * ratioY, 1e-9, `${c.handle}: shape b height ratio`);
    }
});

run('selection overlay redraws a single union frame with eight handles', () => {
    const a = rect(100, 100, 100, 50);
    const b = rect(300, 200, 50, 100);
    const vexel = createVexel([a, b]);
    vexel.viewport = { x: 12, y: 34, zoom: 1.5, rotation: 0 };

    const calls = { strokeRect: [], rect: [], arc: [] };
    const ctx = {
        save() {}, restore() {}, translate() {}, scale() {}, beginPath() {},
        setLineDash() {}, fill() {}, stroke() {},
        strokeRect(...args) { calls.strokeRect.push(args); },
        rect(...args) { calls.rect.push(args); },
        arc(...args) { calls.arc.push(args); }
    };

    vexel.overlayCtx = ctx;
    vexel._drawSelectionHandles();

    const union = rt.VexelSelectionGeometry.selectionBounds([a, b]);
    assert(calls.strokeRect.length === 1, 'exactly one selection rectangle is stroked');
    assert(calls.strokeRect[0][0] === union.x && calls.strokeRect[0][1] === union.y &&
        calls.strokeRect[0][2] === union.width && calls.strokeRect[0][3] === union.height,
        'selection rectangle matches the union bounds');
    assert(calls.rect.length === 8, 'exactly eight handles are drawn');

    // Handles land on the union corners/edges.
    const expected = Object.values(rt.VexelSelectionGeometry.handlePositions(union));
    for (let i = 0; i < expected.length; i++) {
        const size = 7 / vexel.viewport.zoom;
        approx(calls.rect[i][0] + size / 2, expected[i].x, 1e-9, `handle ${i} x on union`);
        approx(calls.rect[i][1] + size / 2, expected[i].y, 1e-9, `handle ${i} y on union`);
    }
});

run('VexelHistory integration: one undo step restores a multi-selection resize', () => {
    const a = rect(100, 100, 100, 50);
    const b = rect(300, 200, 50, 100);
    const vexel = createVexel([a, b]);

    // Swap in the standalone history implementation used by apps that manage
    // undo themselves; the select tool must record through it.
    const history = new rt.VexelHistory(vexel);
    vexel.history = history;

    const tool = createTool(vexel);
    const before = { a: cloneGeom(snapshotGeometry(a)), b: cloneGeom(snapshotGeometry(b)) };

    dragHandle(tool, vexel, 'se', 50, 50);

    assert(history.getUndoCount() === 1, 'exactly one history step was recorded');
    assert(history.getUndoDescription() === 'transform-shapes', 'history describes the batched transform');

    history.undo();

    approxBounds(a.getBounds(), before.a.bounds, 'VexelHistory undo restores shape a');
    approxBounds(b.getBounds(), before.b.bounds, 'VexelHistory undo restores shape b');
});

run('shapes with cached bounds recompute their union after scaling', () => {
    // Mimic shapes from src/shapes (frame/text/boolean-result) which cache
    // getBounds() behind a dirty flag.
    function cachedShape(x, y, width, height) {
        const s = rect(x, y, width, height);
        s._dirty = false;
        s._cachedBounds = { x, y, width, height };
        s.getBounds = function () {
            if (!this._dirty && this._cachedBounds) return this._cachedBounds;
            this._cachedBounds = { x: this.x, y: this.y, width: this.width * this.scaleX, height: this.height * this.scaleY };
            this._dirty = false;
            return this._cachedBounds;
        };
        return s;
    }

    const a = cachedShape(100, 100, 100, 50);
    const b = rect(300, 200, 50, 100);
    const vexel = createVexel([a, b]);
    const tool = createTool(vexel);

    dragHandle(tool, vexel, 'se', 100, 50);

    // Union is 250x200 -> 350x250, so the x ratio is 1.4.
    const b2 = a.getBounds();
    assert(a._dirty === true || a._cachedBounds === null || b2.width > 100,
        'cached shape invalidates its bounds cache after scaling');
    approx(b2.width, 140, 1e-9, 'cached shape reports its scaled width');
});

run('path and text shapes scale through their natural geometry', () => {
    const path = new rt.VexelPath([{ x: 100, y: 100 }, { x: 200, y: 150 }], { stroke: '#000' });
    const text = new rt.VexelText(300, 300, 'Hello', { fontSize: 20 });
    const vexel = createVexel([path, text]);
    const tool = createTool(vexel);

    const pathBefore = path.points.map(p => ({ x: p.x, y: p.y }));
    const textBefore = { x: text.x, y: text.y, fontSize: text.fontSize };

    dragHandle(tool, vexel, 'se', 100, 100);

    // The path's first point sits on the union origin, so it stays put; its
    // second point must move with the scale.
    assert(path.points[1].x !== pathBefore[1].x || path.points[1].y !== pathBefore[1].y,
        'path points are scaled');
    assert(text.fontSize > textBefore.fontSize, 'text font size scales');

    vexel.undo();

    approx(path.points[1].x, pathBefore[1].x, 1e-9, 'undo restores path point x');
    approx(path.points[1].y, pathBefore[1].y, 1e-9, 'undo restores path point y');
    approx(text.fontSize, textBefore.fontSize, 1e-9, 'undo restores text font size');
});

run('nested groups scale their children and restore on undo', () => {
    const inner = new rt.VexelGroup([
        rect(100, 100, 50, 50),
        rect(200, 150, 50, 50)
    ]);
    const outer = rect(400, 400, 100, 100);

    const vexel = createVexel([inner, outer]);
    const tool = createTool(vexel);

    const innerChildrenBefore = inner.shapes.map(s => ({ x: s.x, y: s.y, w: s.width, h: s.height }));
    const unionBefore = tool.getSelectionBounds();

    dragHandle(tool, vexel, 'se', 100, 100);

    const ratioX = tool.getSelectionBounds().width / unionBefore.width;
    const ratioY = tool.getSelectionBounds().height / unionBefore.height;

    inner.shapes.forEach((child, i) => {
        approx(child.width, innerChildrenBefore[i].w * ratioX, 1e-9, `group child ${i} scales`);
        approx(child.height, innerChildrenBefore[i].h * ratioY, 1e-9, `group child ${i} scales (height)`);
    });

    vexel.undo();
    approxBounds(inner.getBounds(), {
        x: Math.min(...innerChildrenBefore.map(c => c.x)),
        y: Math.min(...innerChildrenBefore.map(c => c.y)),
        width: Math.max(...innerChildrenBefore.map(c => c.x + c.w)) - Math.min(...innerChildrenBefore.map(c => c.x)),
        height: Math.max(...innerChildrenBefore.map(c => c.y + c.h)) - Math.min(...innerChildrenBefore.map(c => c.y))
    }, 'undo restores nested group geometry');
});

run('VexelHistory integration: move drags also undo as a single step', () => {
    const a = rect(100, 100, 100, 50);
    const b = rect(300, 200, 50, 100);
    const vexel = createVexel([a, b]);
    const history = new rt.VexelHistory(vexel);
    vexel.history = history;
    const tool = createTool(vexel);

    const before = { a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y } };

    tool._handleMouseDown(mouseEvent(150, 125));
    tool._handleMouseMove(mouseEvent(170, 145));
    tool._handleMouseMove(mouseEvent(190, 165));
    tool._handleMouseUp(mouseEvent(190, 165));

    assert(history.getUndoCount() === 1, 'one history step for a multi-selection move');
    assert(history.getUndoDescription() === 'move-shapes', 'history describes the move');

    history.undo();
    approx(a.x, before.a.x, 1e-9, 'history undo restores a.x');
    approx(b.x, before.b.x, 1e-9, 'history undo restores b.x');
});

run('explicit-endpoint connectors scale their endpoints and undo restores them', () => {
    function connector(start, end) {
        return {
            type: 'connector',
            id: 'conn_' + start.x,
            visible: true,
            startPoint: { ...start },
            endPoint: { ...end },
            getBounds() {
                return {
                    x: Math.min(this.startPoint.x, this.endPoint.x),
                    y: Math.min(this.startPoint.y, this.endPoint.y),
                    width: Math.abs(this.endPoint.x - this.startPoint.x),
                    height: Math.abs(this.endPoint.y - this.startPoint.y)
                };
            }
        };
    }

    const conn = connector({ x: 100, y: 100 }, { x: 200, y: 200 });
    const box = rect(300, 300, 100, 100);
    const vexel = createVexel([conn, box]);
    const tool = createTool(vexel);

    const before = { start: { ...conn.startPoint }, end: { ...conn.endPoint } };

    dragHandle(tool, vexel, 'se', 100, 100);

    assert(conn.endPoint.x > before.end.x, 'connector end point moved with the drag');
    assert(conn.startPoint.y < conn.endPoint.y, 'connector keeps a valid orientation');

    vexel.undo();

    approx(conn.startPoint.x, before.start.x, 1e-9, 'undo restores connector start x');
    approx(conn.startPoint.y, before.start.y, 1e-9, 'undo restores connector start y');
    approx(conn.endPoint.x, before.end.x, 1e-9, 'undo restores connector end x');
    approx(conn.endPoint.y, before.end.y, 1e-9, 'undo restores connector end y');
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${passCount} assertions passed, ${failCount} failed.`);

if (failCount > 0) {
    console.error('\nFailures:');
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
}

console.log('All multi-selection transform checks passed.');
