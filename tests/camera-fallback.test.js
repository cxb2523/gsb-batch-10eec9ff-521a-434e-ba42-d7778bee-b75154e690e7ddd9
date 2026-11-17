/*
 * Locally runnable verification for keyframe camera fallback.
 *
 *   node tests/camera-fallback.test.js
 *
 * No browser, no network and no npm dependencies are required. The test loads
 * player.js into a vm sandbox with a small WebGLRenderer stub and exercises the
 * same functions the player and the editor viewport use, so both sides are
 * checked against one rule:
 *
 *   1. camera of the keyframe exactly at the requested time
 *   2. camera of the nearest earlier keyframe that has a camera
 *   3. the default camera (cameraId 0)
 */
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var assert = require('assert');

var ROOT = path.join(__dirname, '..');
var THREE = require(path.join(ROOT, 'js', 'three.js'));

// Never touch a real canvas / WebGL context in Node.
var sandboxThree = Object.assign({}, THREE);
sandboxThree.WebGLRenderer = function () {
    this.domElement = { style: {} };
    this.setSize = function () {};
    this.render = function (scene, camera) {
        this.lastScene = scene;
        this.lastCamera = camera;
    };
};

var sandbox = {
    THREE: sandboxThree,
    console: console,
    document: {
        getElementById: function () {
            return { appendChild: function () {}, clientWidth: 640, clientHeight: 360, style: {} };
        }
    },
    XMLHttpRequest: function () {}
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'player.js'), 'utf8'), sandbox, { filename: 'player.js' });

var failures = 0;
var passes = 0;

function test(name, fn) {
    try {
        fn();
        passes++;
        console.log('  PASS  ' + name);
    } catch (err) {
        failures++;
        console.log('  FAIL  ' + name);
        console.log('        ' + (err && err.message ? err.message : err));
    }
}

function nearlyEqual(a, b, msg) {
    assert.ok(Math.abs(a - b) < 1e-9, msg + ' (expected ' + b + ', got ' + a + ')');
}

// Build a player context the same way the editor does, but without jQuery.
function makeContext() {
    var pcx = sandbox.createContext('test-' + Math.random().toString(36).slice(2));
    pcx.settings = {
        length: 1000,
        framerate: 60,
        aspectRatio: '16:9',
        autoplay: false,
        loop: false,
        lineColor: 0xffffff,
        bgColor: 0
    };
    pcx.keyframes = [];
    return pcx;
}

function addCamera(pcx, name, id, cameraId, fov) {
    var node = sandbox.createEmptyNodePlayer(name, pcx.sceneTree, id);
    return sandbox.createCameraPlayer(pcx, node, cameraId, fov || 45);
}

function addEmpty(pcx, name, id) {
    return sandbox.createEmptyNodePlayer(name, pcx.sceneTree, id);
}

function addKeyframe(pcx, time, cameraId, nodes) {
    var kf = { time: time, nodes: nodes || [] };
    if (cameraId !== undefined)
        kf.cameraId = cameraId;
    pcx.keyframes.push(kf);
    return kf;
}

// Standard scene: default camera (cameraId 0) plus two extra cameras.
function makeScene() {
    var pcx = makeContext();
    addCamera(pcx, 'default camera', 1, 0, 45);
    addCamera(pcx, 'camera A', 2, 1, 60);
    addCamera(pcx, 'camera B', 3, 2, 30);
    addEmpty(pcx, 'cube', 4);
    return pcx;
}

function cameraName(node) {
    return node == null ? null : node.name;
}

// Renders through the editor viewport path and returns the cameraObject that
// actually reached the renderer.
function editorCameraObject(pcx, cameraId, followsKeyframes, time) {
    var viewport = {
        cameraId: cameraId,
        renderer: new sandboxThree.WebGLRenderer()
    };
    var rendered = sandbox.renderCameraViewport(pcx, viewport, followsKeyframes, time);
    return { rendered: rendered, cameraObject: viewport.renderer.lastCamera };
}

function playerCameraObject(pcx, time) {
    var camera = sandbox.seekTimePlayer(pcx, time);
    var renderer = new sandboxThree.WebGLRenderer();
    var rendered = sandbox.renderWithCamera(renderer, pcx.scene, camera);
    return { camera: camera, rendered: rendered, cameraObject: renderer.lastCamera };
}

// ---------------------------------------------------------------------------
console.log('\n1. Exact keyframe at the current time');
// ---------------------------------------------------------------------------
test('uses the camera of the keyframe at the exact time', function () {
    var pcx = makeScene();
    addKeyframe(pcx, 0, 0, [{ id: 4, pos: { x: 1, y: 2, z: 3 } }]);
    addKeyframe(pcx, 100, 2, [{ id: 4, pos: { x: 9, y: 9, z: 9 } }]);
    assert.strictEqual(cameraName(sandbox.getKeyframeCamera(pcx, 100)), 'camera B');
});

test('exact hit allows a keyframe without node data', function () {
    var pcx = makeScene();
    addKeyframe(pcx, 50, 1);
    assert.strictEqual(cameraName(sandbox.getKeyframeCamera(pcx, 50)), 'camera A');
});

test('exact hit wins over an earlier camera keyframe', function () {
    var pcx = makeScene();
    addKeyframe(pcx, 10, 1);
    addKeyframe(pcx, 20, 2);
    assert.strictEqual(cameraName(sandbox.getKeyframeCamera(pcx, 20)), 'camera B');
});

// ---------------------------------------------------------------------------
console.log('\n2. Only a forward keyframe has a camera');
// ---------------------------------------------------------------------------
test('time between keyframes falls back to the default camera', function () {
    var pcx = makeScene();
    addKeyframe(pcx, 0, undefined, [{ id: 4, pos: { x: 0, y: 0, z: 0 } }]);
    addKeyframe(pcx, 100, 1, [{ id: 4, pos: { x: 100, y: 0, z: 0 } }]);
    assert.strictEqual(cameraName(sandbox.getKeyframeCamera(pcx, 50)), 'default camera');
});

test('keyframe before the first camera keyframe uses the default camera', function () {
    var pcx = makeScene();
    addKeyframe(pcx, 10, 1);
    assert.strictEqual(cameraName(sandbox.getKeyframeCamera(pcx, 9)), 'default camera');
});

test('nearest earlier keyframe with a camera is chosen, not the first one', function () {
    var pcx = makeScene();
    addKeyframe(pcx, 10, 1);
    addKeyframe(pcx, 40, 2);
    addKeyframe(pcx, 90, 1);
    assert.strictEqual(cameraName(sandbox.getKeyframeCamera(pcx, 80)), 'camera B');
});

test('keyframes without cameraId are skipped when searching backwards', function () {
    var pcx = makeScene();
    addKeyframe(pcx, 10, 1);
    addKeyframe(pcx, 60, undefined, [{ id: 4, pos: { x: 5, y: 5, z: 5 } }]);
    assert.strictEqual(cameraName(sandbox.getKeyframeCamera(pcx, 80)), 'camera A');
});

// ---------------------------------------------------------------------------
console.log('\n3. No keyframe has a camera');
// ---------------------------------------------------------------------------
test('falls back to the default camera for every time', function () {
    var pcx = makeScene();
    addKeyframe(pcx, 0, undefined, [{ id: 4, pos: { x: 0, y: 0, z: 0 } }]);
    addKeyframe(pcx, 100, undefined, [{ id: 4, pos: { x: 1, y: 2, z: 3 } }]);
    [0, 1, 50, 100, 700].forEach(function (time) {
        assert.strictEqual(cameraName(sandbox.getKeyframeCamera(pcx, time)), 'default camera',
            'time ' + time);
    });
});

test('no keyframes at all falls back to the default camera', function () {
    var pcx = makeScene();
    assert.strictEqual(cameraName(sandbox.getKeyframeCamera(pcx, 0)), 'default camera');
    assert.strictEqual(cameraName(sandbox.getKeyframeCamera(pcx, 500)), 'default camera');
});

// ---------------------------------------------------------------------------
console.log('\n4. Player and editor viewport agree');
// ---------------------------------------------------------------------------
function assertSameCameraForTime(pcx, time) {
    var player = playerCameraObject(pcx, time);
    var editor = editorCameraObject(pcx, -2 /* CAMERA.key */, true, time);
    assert.ok(player.camera != null, 'player resolved a camera at ' + time);
    assert.ok(editor.rendered, 'editor rendered at ' + time);
    assert.strictEqual(editor.cameraObject, player.camera.cameraObject,
        'same cameraObject at time ' + time);
    return player.camera;
}

test('exact / forward-only / no-camera scenes render identically', function () {
    var exact = makeScene();
    addKeyframe(exact, 0, 0);
    addKeyframe(exact, 100, 2);
    assert.strictEqual(assertSameCameraForTime(exact, 100).name, 'camera B');

    var forward = makeScene();
    addKeyframe(forward, 0, undefined, [{ id: 4, pos: { x: 0, y: 0, z: 0 } }]);
    addKeyframe(forward, 100, 1);
    assert.strictEqual(assertSameCameraForTime(forward, 50).name, 'default camera');

    var none = makeScene();
    addKeyframe(none, 0, undefined, [{ id: 4, pos: { x: 0, y: 0, z: 0 } }]);
    addKeyframe(none, 100, undefined, [{ id: 4, pos: { x: 1, y: 1, z: 1 } }]);
    assert.strictEqual(assertSameCameraForTime(none, 60).name, 'default camera');
});

test('editor viewport pinned to a specific camera still resolves it', function () {
    var pcx = makeScene();
    var editor = editorCameraObject(pcx, 2 /* camera B */, false, 0);
    assert.ok(editor.rendered);
    assert.strictEqual(editor.cameraObject.fov, 30);
});

// ---------------------------------------------------------------------------
console.log('\n5. Deleted camera nodes and missing data');
// ---------------------------------------------------------------------------
test('keyframe pointing at a deleted camera falls back to the default camera', function () {
    var pcx = makeScene();
    addKeyframe(pcx, 100, 99 /* camera does not exist */);
    assert.strictEqual(cameraName(sandbox.getKeyframeCamera(pcx, 100)), 'default camera');
});

test('removeNode repoints keyframes to the default camera and re-seeks cleanly', function () {
    var pcx = makeScene();
    var cameraB = sandbox.findCamera(pcx, 2);
    var kf = addKeyframe(pcx, 100, 2, [
        { id: 3, pos: { x: 1, y: 1, z: 1 } },
        { id: 4, pos: { x: 2, y: 2, z: 2 } }
    ]);
    var parent = sandbox.removeNode(pcx, cameraB);

    assert.strictEqual(parent.id, 0, 'camera B was removed from the root');
    assert.strictEqual(kf.cameraId, 0, 'keyframe camera repointed to default');
    assert.strictEqual(kf.nodes.length, 1, 'data for the deleted node was dropped');
    assert.strictEqual(kf.nodes[0].id, 4);
    assert.strictEqual(sandbox.findCamera(pcx, 2), null);

    var player = playerCameraObject(pcx, 100);
    assert.ok(player.rendered);
    assert.strictEqual(player.camera.name, 'default camera');
});

test('removing the camera keyframe re-seeks to the previous camera keyframe', function () {
    var pcx = makeScene();
    addKeyframe(pcx, 0, 0);
    addKeyframe(pcx, 40, 1);
    addKeyframe(pcx, 100, 2);

    // Emulate removeKeyframe(): drop the keyframe at the playhead time, then
    // seek again from the playhead.
    pcx.keyframes.splice(pcx.keyframes.findIndex(function (kf) { return kf.time === 100; }), 1);
    var reseeked = sandbox.seekTimePlayer(pcx, 100);
    assert.strictEqual(reseeked.name, 'camera A');

    var editor = editorCameraObject(pcx, -2, true, 100);
    assert.strictEqual(editor.cameraObject, reseeked.cameraObject);
});

test('no usable camera anywhere does not dereference cameraObject', function () {
    var pcx = makeContext();
    addEmpty(pcx, 'cube', 1);
    addKeyframe(pcx, 0, undefined, [{ id: 1, pos: { x: 0, y: 0, z: 0 } }]);

    assert.strictEqual(sandbox.seekTimePlayer(pcx, 0), null);
    var renderer = new sandboxThree.WebGLRenderer();
    assert.strictEqual(sandbox.renderWithCamera(renderer, pcx.scene, null), false);
    assert.strictEqual(renderer.lastCamera, undefined);

    var editor = editorCameraObject(pcx, -2, true, 0);
    assert.strictEqual(editor.rendered, false);
    assert.strictEqual(editor.cameraObject, undefined);
});

test('seekTimePlayer tolerates keyframe data for a deleted node', function () {
    var pcx = makeScene();
    addKeyframe(pcx, 0, 0, [
        { id: 4, pos: { x: 0, y: 0, z: 0 } },
        { id: 77, pos: { x: 5, y: 5, z: 5 } } // node no longer exists
    ]);
    assert.doesNotThrow(function () {
        sandbox.seekTimePlayer(pcx, 0);
    });
    var obj = sandbox.findNode(pcx, 4).threeObject;
    nearlyEqual(obj.position.x, 0, 'existing node still updated');
});

test('seekTimePlayer tolerates keyframes with no nodes array', function () {
    var pcx = makeScene();
    pcx.keyframes = [{ time: 0, cameraId: 0 }];
    assert.doesNotThrow(function () {
        sandbox.seekTimePlayer(pcx, 0);
    });
    assert.doesNotThrow(function () {
        sandbox.seekTimePlayer(pcx, 500);
    });
});

// ---------------------------------------------------------------------------
console.log('\n6. Keyframe info panel tolerates missing nodes');
// ---------------------------------------------------------------------------
test('updateKFInfo does not throw when the node data is gone', function () {
    var appended = [];
    function fakeJquery() {
        return {
            empty: function () { return this; },
            append: function (html) { appended.push(html); return this; },
            text: function () { return this; }
        };
    }
    var kfSandbox = {
        THREE: sandboxThree,
        console: console,
        layout: { registerComponent: function () {} },
        $: fakeJquery,
        pcx: makeScene(),
        getKeyframe: sandbox.getKeyframe,
        findNode: sandbox.findNode
    };
    kfSandbox.pcx.keyframes = [{ time: 0, nodes: [{ id: 123, pos: { x: 0, y: 0, z: 0 } }] }];
    vm.createContext(kfSandbox);
    vm.runInContext(
        fs.readFileSync(path.join(ROOT, 'components', 'keyframe-component.js'), 'utf8'),
        kfSandbox,
        { filename: 'keyframe-component.js' }
    );

    kfSandbox.updateKFInfo();
    assert.ok(appended.length > 0, 'panel rendered a placeholder entry');
    assert.ok(appended.join('').indexOf('123') != -1, 'shows the missing node id');
});

// ---------------------------------------------------------------------------
console.log('\n7. Keyframe interpolation is unchanged');
// ---------------------------------------------------------------------------
test('position/rotation/scale interpolation still works', function () {
    var pcx = makeScene();
    addKeyframe(pcx, 0, 0, [{
        id: 4,
        pos: { x: 0, y: 0, z: 0 },
        rot: { x: 0, y: 0, z: 0, w: 1 },
        scale: { x: 1, y: 1, z: 1 }
    }]);
    addKeyframe(pcx, 100, 0, [{
        id: 4,
        pos: { x: 100, y: 200, z: -100 },
        rot: { x: 0, y: 0.7071068, z: 0, w: 0.7071068 },
        scale: { x: 2, y: 3, z: 4 }
    }]);

    sandbox.seekTimePlayer(pcx, 50);
    var obj = sandbox.findNode(pcx, 4).threeObject;
    nearlyEqual(obj.position.x, 50, 'interpolated x');
    nearlyEqual(obj.position.y, 100, 'interpolated y');
    nearlyEqual(obj.position.z, -50, 'interpolated z');
    nearlyEqual(obj.scale.x, 1.5, 'interpolated scale x');
    nearlyEqual(obj.scale.y, 2, 'interpolated scale y');
    nearlyEqual(obj.scale.z, 2.5, 'interpolated scale z');
    nearlyEqual(obj.quaternion.y, Math.sin(Math.PI / 8), 'slerped quaternion y');
});

test('FOV and aspect ratio behavior is unchanged', function () {
    var pcx = makeScene();
    addKeyframe(pcx, 0, 1);
    var camera = sandbox.findCamera(pcx, 1);
    camera.cameraObject.fov = 60; // deliberately wrong
    var result = editorCameraObject(pcx, -2, true, 0);
    assert.ok(result.rendered);
    assert.strictEqual(result.cameraObject.fov, 60);
    nearlyEqual(result.cameraObject.aspect, 16 / 9, 'aspect ratio from settings');
});

// ---------------------------------------------------------------------------
console.log('\n8. Real demo project data (lightcycles.json)');
// ---------------------------------------------------------------------------
test('demo keyframes resolve to the same camera in player and editor', function () {
    var project = JSON.parse(fs.readFileSync(path.join(ROOT, 'demos', 'lightcycles.json'), 'utf8'));
    var pcx = makeContext();
    pcx.settings = project.settings;
    pcx.keyframes = project.keyframes;

    // Build the scene tree without model/shape geometry: the camera rule and
    // the interpolation code only need node ids and transforms.
    (function walk(loadNode, parent) {
        (loadNode.children || []).forEach(function (child) {
            var node = sandbox.createEmptyNodePlayer(child.name, parent, child.id);
            if (child.cameraId !== undefined)
                sandbox.createCameraPlayer(pcx, node, child.cameraId, child.cameraFov);
            walk(child, node);
        });
    })(project.sceneTree, pcx.sceneTree);

    // lightcycles.json has camera keyframes at 300 and 700 (cameraId 1).
    assert.strictEqual(sandbox.getKeyframeCamera(pcx, 300).cameraId, 1, 'exact hit at 300');
    assert.strictEqual(sandbox.getKeyframeCamera(pcx, 500).cameraId, 1, 'forward fallback at 500');
    assert.strictEqual(sandbox.getKeyframeCamera(pcx, 700).cameraId, 1, 'exact hit at 700');
    assert.strictEqual(sandbox.getKeyframeCamera(pcx, 100).cameraId, 0, 'default before first camera keyframe');
    assert.strictEqual(sandbox.getKeyframeCamera(pcx, 900).cameraId, 1, 'previous camera after last camera keyframe');

    [0, 100, 300, 500, 700, 900].forEach(function (time) {
        var player = playerCameraObject(pcx, time);
        var editor = editorCameraObject(pcx, -2, true, time);
        assert.ok(player.rendered && editor.rendered, 'both render at ' + time);
        assert.strictEqual(player.camera.cameraObject, editor.cameraObject,
            'same camera at ' + time);
    });
});

// ---------------------------------------------------------------------------
console.log('\n' + passes + ' passed, ' + failures + ' failed');
process.exit(failures === 0 ? 0 : 1);
