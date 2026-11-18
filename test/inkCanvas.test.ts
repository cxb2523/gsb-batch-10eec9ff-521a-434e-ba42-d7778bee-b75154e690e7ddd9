import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Scene } from "@babylonjs/core/scene";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";

import { InkCanvas } from "../src/inkCanvas";
import { PathMesh, BrushMode } from "../src/path/pathMesh";

/**
 * Headless InkCanvas tests driven by a Babylon NullEngine.
 * They cover the inking history contract:
 *  - each stroke freezes its own brush style on pointer down
 *  - undo/redo restores the original material, not the current brush
 *  - clear empties both stacks and disposes the strokes for good
 *  - undo/redo are ignored while a stroke is being drawn
 *  - rainbow particles only run on the live rainbow stroke
 */

let engine: NullEngine;
let ink: InkCanvas;
let scene: Scene;

/**
 * Simulates a full stroke between two points. The points are spread far
 * enough apart for the PathBufferData smoothing to actually emit vertices.
 */
function drawStroke(fromX: number, fromY: number, toX: number, toY: number): PathMesh {
    scene.pointerX = fromX;
    scene.pointerY = fromY;
    ink.startPath();

    const path = ink.currentPath!;
    assert.ok(path, "a path must be created on startPath");

    for (let i = 1; i <= 8; i++) {
        scene.pointerX = fromX + ((toX - fromX) * i) / 8;
        scene.pointerY = fromY + ((toY - fromY) * i) / 8;
        ink.extendPath();
    }

    ink.endPath();
    assert.equal(ink.isDrawing, false, "drawing must be over after endPath");

    // Flush the buffered geometry updates the same way the render loop would.
    scene.render();

    return path;
}

/**
 * Reads the color uniform stored on a pen ShaderMaterial.
 */
function getMaterialColor(material: unknown): Color3 {
    return (material as unknown as { _colors3: { color: Color3 } })._colors3.color;
}

/**
 * Reads the radius actually used to build a path geometry from its vertices.
 * The start cap is a circle centered on the first point, so the distance
 * between the center vertex and the first contour vertex equals the radius.
 */
function getGeometryRadius(path: PathMesh): number {
    const positions = path.getVerticesData(VertexBuffer.PositionKind)!;
    const cx = positions[0];
    const cy = positions[1];
    const vx = positions[3];
    const vy = positions[4];
    return Math.sqrt((vx - cx) * (vx - cx) + (vy - cy) * (vy - cy));
}

beforeEach(() => {
    engine = new NullEngine();
    // No DOM canvas and no real texture file are needed with a NullEngine.
    ink = new InkCanvas(null, "particle.png", false, engine);
    scene = ink.scene;
});

afterEach(() => {
    engine.dispose();
});

test("two strokes with different colors keep their own color after undo and redo", () => {
    ink.usePen();

    ink.changeColor(Color3.Black());
    const blackStroke = drawStroke(10, 10, 200, 120);

    ink.changeColor(Color3.White());
    const whiteStroke = drawStroke(30, 30, 240, 160);

    assert.equal(ink.pathCount, 2);
    assert.deepEqual(blackStroke.brushColor.asArray(), Color3.Black().asArray());
    assert.deepEqual(whiteStroke.brushColor.asArray(), Color3.White().asArray());

    // Undo the white stroke.
    ink.undo();
    assert.equal(ink.pathCount, 1);
    assert.equal(ink.redoCount, 1);

    // Redo it: the material must be the original white one, even though the
    // live brush is still white here and even after switching it below.
    ink.changeColor(Color3.Red());
    ink.redo();

    assert.equal(ink.pathCount, 2);
    assert.equal(ink.redoCount, 0);

    const redone = ink.getPathAt(1);
    assert.equal(redone, whiteStroke, "redo must bring back the very same mesh");
    assert.equal(redone.material, whiteStroke.material, "redo must keep the original material instance");
    assert.deepEqual(getMaterialColor(redone.material).asArray(), Color3.White().asArray());
    assert.deepEqual(redone.brushColor.asArray(), Color3.White().asArray());
});

test("changing the brush size does not resize an already finished stroke and redo keeps the old thickness", () => {
    ink.usePen();

    ink.changeSize(5);
    const thickStroke = drawStroke(20, 20, 300, 200);
    assert.equal(thickStroke.brushSize, 5);
    assert.ok(Math.abs(getGeometryRadius(thickStroke) - 5) < 0.001);

    ink.undo();

    // Switch the brush size while the stroke lives only in the redo stack.
    ink.changeSize(15);
    ink.redo();

    const redone = ink.getPathAt(0);
    assert.equal(redone, thickStroke);
    assert.equal(redone.brushSize, 5, "redo must restore the captured size, not the current one");
    assert.ok(
        Math.abs(getGeometryRadius(redone) - 5) < 0.001,
        "the geometry of a redone stroke must keep its original thickness"
    );

    // A brand new stroke uses the new size.
    const newStroke = drawStroke(40, 40, 320, 220);
    assert.equal(newStroke.brushSize, 15);
    assert.ok(Math.abs(getGeometryRadius(newStroke) - 15) < 0.001);

    // And the old stroke is untouched.
    assert.ok(Math.abs(getGeometryRadius(thickStroke) - 5) < 0.001);
});

test("clear empties both undo and redo stacks and redo cannot resurrect cleared strokes", () => {
    ink.usePen();
    ink.changeColor(Color3.Black());
    const first = drawStroke(10, 10, 150, 100);
    const second = drawStroke(20, 20, 180, 140);

    // Put one stroke in the redo stack and keep one visible.
    ink.undo();
    assert.equal(ink.pathCount, 1);
    assert.equal(ink.redoCount, 1);

    ink.clear();

    assert.equal(ink.pathCount, 0);
    assert.equal(ink.redoCount, 0, "clear must empty the redo stack as well");
    assert.equal(scene.meshes.filter((m) => m instanceof PathMesh).length, 0);
    assert.equal(first.isDisposed(), true);
    assert.equal(second.isDisposed(), true);

    // Redo must be a no-op: the cleared strokes are gone for good.
    ink.redo();
    assert.equal(ink.pathCount, 0);
    assert.equal(ink.redoCount, 0);
    assert.equal(scene.meshes.filter((m) => m instanceof PathMesh).length, 0);

    // Undo is a no-op too.
    ink.undo();
    assert.equal(ink.pathCount, 0);
});

test("undo and redo are ignored while a stroke is being drawn", () => {
    ink.usePen();
    const finished = drawStroke(10, 10, 120, 90);
    assert.equal(ink.pathCount, 1);

    // Start a second stroke and leave it in progress.
    scene.pointerX = 50;
    scene.pointerY = 50;
    ink.startPath();
    assert.equal(ink.isDrawing, true);

    ink.undo();
    assert.equal(ink.pathCount, 1, "undo during drawing must not pop the finished stroke");
    assert.equal(ink.redoCount, 0);

    ink.redo();
    assert.equal(ink.pathCount, 1, "redo during drawing must be ignored");

    // Finishing the stroke commits it normally.
    scene.pointerX = 200;
    scene.pointerY = 160;
    ink.extendPath();
    ink.endPath();
    assert.equal(ink.pathCount, 2);

    // And history works again once drawing is over.
    ink.undo();
    assert.equal(ink.pathCount, 1);
    ink.redo();
    assert.equal(ink.pathCount, 2);
    assert.equal(finished.isDisposed(), false);
});

/**
 * Tells whether the particle system has been stopped. Babylon's stop() only
 * flips an internal flag until the next simulation tick drains the particles,
 * so isStarted() can remain true for a frame; _stopped reflects the call itself.
 */
function isParticleSystemStopped(): boolean {
    return (ink.particleSystem as unknown as { _stopped: boolean })._stopped;
}

test("rainbow particles only run on the stroke currently being drawn", () => {
    ink.useRainbow();

    scene.pointerX = 10;
    scene.pointerY = 10;
    ink.startPath();
    const livePath = ink.currentPath!;
    assert.equal(ink.particleSystem.isStarted(), true, "particles run while a rainbow stroke is being drawn");
    assert.equal(isParticleSystemStopped(), false);

    for (let i = 1; i <= 8; i++) {
        scene.pointerX = 10 + (210 * i) / 8;
        scene.pointerY = 10 + (160 * i) / 8;
        ink.extendPath();
    }
    ink.endPath();
    scene.render();

    const rainbowStroke = livePath;
    assert.equal(rainbowStroke.brushMode, BrushMode.rainbow);
    assert.equal(isParticleSystemStopped(), true, "particles stop as soon as the stroke ends");

    ink.undo();
    assert.equal(isParticleSystemStopped(), true, "undo must not start particles");
    assert.equal(ink.pathCount, 0);

    ink.redo();
    assert.equal(isParticleSystemStopped(), true, "redo of a finished stroke must not start particles");
    assert.equal(ink.pathCount, 1);
    assert.equal(ink.getPathAt(0), rainbowStroke);
    assert.equal(rainbowStroke.brushMode, BrushMode.rainbow);

    // A pen stroke never starts the particles.
    ink.usePen();
    drawStroke(30, 30, 180, 130);
    assert.equal(isParticleSystemStopped(), true);
});

test("switching brush mode after a stroke is drawn does not change the recorded mode or material", () => {
    ink.useRainbow();
    const rainbowStroke = drawStroke(10, 10, 160, 120);
    const rainbowMaterial = rainbowStroke.material;

    ink.usePen();
    ink.changeColor(Color3.Black());
    const penStroke = drawStroke(20, 20, 200, 160);

    assert.equal(rainbowStroke.brushMode, BrushMode.rainbow);
    assert.equal(penStroke.brushMode, BrushMode.pen);
    assert.equal(rainbowStroke.material, rainbowMaterial, "the rainbow material instance must be preserved");
    assert.deepEqual(penStroke.brushColor.asArray(), Color3.Black().asArray());

    // Undo/redo round trip keeps every stroke on its original material.
    ink.undo();
    ink.undo();
    assert.equal(ink.pathCount, 0);
    ink.redo();
    ink.redo();
    assert.equal(ink.getPathAt(0), rainbowStroke);
    assert.equal(ink.getPathAt(0).material, rainbowMaterial);
    assert.equal(ink.getPathAt(1), penStroke);
    assert.deepEqual(getMaterialColor(ink.getPathAt(1).material).asArray(), Color3.Black().asArray());
});

test("starting a new stroke invalidates the redo stack", () => {
    ink.usePen();
    drawStroke(10, 10, 120, 90);
    ink.undo();
    assert.equal(ink.redoCount, 1);

    drawStroke(20, 20, 160, 120);
    assert.equal(ink.redoCount, 0, "drawing a new stroke must discard redo history");
    assert.equal(ink.pathCount, 1);

    ink.redo();
    assert.equal(ink.pathCount, 1, "redo after a new stroke must be a no-op");
});
