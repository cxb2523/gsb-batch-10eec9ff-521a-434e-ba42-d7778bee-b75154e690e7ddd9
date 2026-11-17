var playerContexts = {};

function createContext(name) {
    var context = {
        time: 0,
        timerId: -1,
        scene: new THREE.Scene(),
        sceneTree: {
            id: 0, 
            name: 'root', 
            children:[], 
            threeObject: new THREE.Object3D()
        },
        divName: name,
        settings: {},
        models: [],
        shapes: [],
        keyframes: [],
        renderer: new THREE.WebGLRenderer({antialias: true})
    };
    context.scene.add(context.sceneTree.threeObject);
    playerContexts[name] = context;
    return context;
}

function getContext(name) {
    return playerContexts[name];
}

function loadProjectPlayer(url, pcx, doneLoading) {
    loadJSON(url, pcx, function(project) {
        loadSettingsPlayer(pcx, project.settings);
        pcx.models = project.models;
        pcx.keyframes = project.keyframes;
        pcx.shapes = project.shapes;
        traverseTree(pcx, function (loadNode) {
            if (loadNode.id == 0) {
                return;
            }
            else {
                var parentProject = getParentNode(pcx, loadNode, project.sceneTree);
                var parent = findNode(pcx, parentProject.id);
                var node = createEmptyNodePlayer(loadNode.name, parent, loadNode.id);
                if (loadNode.model !== undefined) {
                    createModelPlayer(pcx, node, loadNode.model);
                }
                else if (loadNode.cameraId !== undefined) {
                    createCameraPlayer(pcx, node, loadNode.cameraId, loadNode.cameraFov);
                }
                else if (loadNode.shape !== undefined) {
                    createShapePlayer(pcx, node, loadNode.shape);
                }
            }
        }, project.sceneTree);
        var div = document.getElementById(pcx.divName);
        div.appendChild(pcx.renderer.domElement);
        var updateSize = function(event, div) {
            div = div || event.srcElement;
            var pcx = getContext(div.id);
            var width = div.clientWidth;
            var height = div.clientHeight;
            var ar = getAspectRatio(pcx.settings.aspectRatio);
            var aspectWidth = width;
            var aspectHeight = height;
            if (width > height)
                aspectHeight = width / ar;
            else if (height > width)
                aspectWidth = height * ar;
            if (aspectHeight > height) {
                aspectHeight = height;
                aspectWidth = height * ar;
            }
            if (aspectWidth > width) {
                aspectWidth = width;
                aspectHeight = width / ar;
            }
            var remainderWidth = width - aspectWidth;
            if (remainderWidth > 0)
                pcx.renderer.domElement.style.marginLeft = remainderWidth / 2 + 'px';
            else
                pcx.renderer.domElement.style.marginLeft = '0px';
            aspectWidth = Math.floor(aspectWidth);
            aspectHeight = Math.floor(aspectHeight);
            pcx.renderer.setSize(aspectWidth, aspectHeight);
            var camera = seekTimePlayer(pcx, pcx.time);
            renderWithCamera(pcx.renderer, pcx.scene, camera);
        }
        updateSize(null, div);
        div.onfullscreenchange = updateSize;
        var camera = seekTimePlayer(pcx, 0);
        renderWithCamera(pcx.renderer, pcx.scene, camera);
        if (doneLoading)
            doneLoading(pcx);
        if (pcx.settings.autoplay)
            playPlayer(pcx.divName);
    }, function(xhr) {
        // Error
        console.log(xhr);
    });
}

function loadJSON(path, pcx, success, error) {
    var xhr = new XMLHttpRequest();
    xhr.onreadystatechange = function() {
        if (xhr.readyState === XMLHttpRequest.DONE) {
            if (xhr.status === 200) {
                if (success)
                    success(JSON.parse(xhr.responseText), pcx);
            }
            else {
                if (error)
                    error(xhr);
            }
        }
    };
    xhr.open("GET", path, true);
    xhr.send();
}

function loadSettingsPlayer(pcx, newSettings) {
    pcx.lineMaterial = new THREE.LineBasicMaterial({color: newSettings.lineColor});
    pcx.wallMaterial = new THREE.MeshBasicMaterial({color: newSettings.bgColor, side: THREE.DoubleSide, 
        polygonOffset: true, // Fix z fighting with lines
        polygonOffsetFactor: 1, // positive value pushes polygon further away
        polygonOffsetUnits: 2 // How far to move back/forward
    });
    pcx.scene.background = new THREE.Color(newSettings.bgColor);
    pcx.settings = newSettings;
}

function getAspectRatio(str) {
    var colonIndex = str.search(':');
    if (colonIndex < 1 || colonIndex == str.length - 1)
        return NaN;
    var width = parseFloat(str.substring(0, colonIndex));
    var height = parseFloat(str.substring(colonIndex + 1, str.length));
    if (width == 0 || height == 0)
        return NaN;
    return  width / height;
}

function findNode(pcx, nodeId, startNode) {
    if (!startNode)
        startNode = pcx.sceneTree;
    if (!startNode)
        return null;
    var found = null;
    if (startNode.id == nodeId)
        return startNode;
    startNode.children.forEach(function(node) {
        var foundSub = findNode(pcx, nodeId, node);
        if (foundSub)
            found = foundSub;
    });
    return found;
}

function getParentNode(pcx, find, tree) {
    var parent = null;
    traverseTree(pcx, function(node) {
        node.children.forEach(function(child) {
            if (child.id == find.id)
                parent = node;
        })
    }, tree);
    return parent;
}

// Remove a node and its subtree. Keyframes that referenced a removed camera
// are repointed at the default camera (cameraId 0) and keyframe data for
// removed nodes is dropped. Returns the removed node's parent.
function removeNode(pcx, node) {
    var cameras = [];
    var deletedNodes = [];
    traverseTree(pcx, function(child) {
        if (child.cameraId !== undefined)
            cameras.push(child.cameraId);
        deletedNodes.push(child.id);
    }, node);
    (pcx.keyframes || []).forEach(function(kf) {
        if (kf.cameraId !== undefined && cameras.indexOf(kf.cameraId) != -1)
            kf.cameraId = 0;
        if (!kf.nodes)
            return;
        for (var i = 0; i < kf.nodes.length; i++) {
            if (kf.nodes[i] != null && deletedNodes.indexOf(kf.nodes[i].id) != -1) {
                kf.nodes.splice(i, 1);
                i--;
            }
        }
    });
    var parent = getParentNode(pcx, node);
    if (parent != null) {
        for (var i = 0; i < parent.children.length; i++) {
            if (parent.children[i].id == node.id) {
                parent.children.splice(i, 1);
                parent.threeObject.remove(node.threeObject);
                break;
            }
        }
    }
    return parent;
}

function getModel(pcx, modelName) {
    for (var i = 0; i < pcx.models.length; i++) {
        if (pcx.models[i].name == modelName)
            return pcx.models[i];
    }
    return null;
}

function getShape(pcx, shapeName) {
    for (var i = 0; i < pcx.shapes.length; i++) {
        if (pcx.shapes[i].name == shapeName)
            return pcx.shapes[i];
    }
    return null;
}

function traverseTree(pcx, func, startNode) {
    if (!startNode)
        startNode = pcx.sceneTree;
    func(startNode);
    startNode.children.forEach(function(node) {
        traverseTree(pcx, func, node);
    });
}

function createEmptyNodePlayer(name, parent, id) {
    var obj = new THREE.Object3D();
    var newNode = {
        id: id,
        name: name,
        children: [],
        threeObject: obj
    };
    if (parent != null) {
        parent.children.push(newNode);
        parent.threeObject.add(obj);
    }
    return newNode;
}

function createModelPlayer(pcx, node, modelName) {
    var model = getModel(pcx, modelName);
    node.model = modelName;
    var linesObject = createModelGeometry(pcx, model.data, modelName);
    node.threeObject.add(linesObject);
    node.modelObject = linesObject;
    return node;
}

function createModelGeometry(pcx, data, modelName) {
    var geometries = [];
    var lines = [];
    data.forEach((point) => {
        point.conn.forEach((otherId) => {
            var other = null;
            data.forEach((candidate) => {
                if (candidate.id == otherId)
                    other = candidate;
            });
            if (other != null) {
                var pos1 = new THREE.Vector3(point.pos.x, point.pos.y, point.pos.z);
                var pos2 = new THREE.Vector3(other.pos.x, other.pos.y, other.pos.z);
                var pt1 = {pointId: point.id, position: pos1};
                var pt2 = {pointId: other.id, position: pos2};
                var scale = 1;
                pt1.position.multiplyScalar(scale);
                pt2.position.multiplyScalar(scale);
                var exists = false;
                lines.forEach((existing) => {
                    if ((existing.id1 == pt1.pointId && existing.id2 == pt2.pointId) ||
                        (existing.id1 == pt2.pointId && existing.id2 == pt1.pointId)) {
                            exists = true;
                    }
                });
                if (!exists) {
                    var geom = new THREE.BufferGeometry();
                    var vertices = new Float32Array([
                        pt1.position.x, pt1.position.y, pt1.position.z,
                        pt2.position.x, pt2.position.y, pt2.position.z
                    ]);
                    geom.setAttribute( 'position', new THREE.BufferAttribute( vertices, 3 ) );
                    geometries.push(geom);
                    var lineData = {
                        id1: pt1.pointId,
                        id2: pt2.pointId,
                    };
                    lines.push(lineData);
                }
            }
        });
    });
    var mergedGeometry = THREE.BufferGeometryUtils.mergeBufferGeometries(geometries);
    var linesObject = new THREE.LineSegments(mergedGeometry, pcx.lineMaterial);
    linesObject.computeLineDistances();
    if (modelName)
        linesObject.model = modelName;
    return linesObject;
}

function createCameraPlayer(pcx, node, cameraId, fov) {
    node.cameraId = cameraId;
    node.cameraFov = fov;
    var camera = new THREE.PerspectiveCamera(node.cameraFov, getAspectRatio(pcx.settings.aspectRatio), 1, 160000);
    node.threeObject.add(camera);
    node.cameraObject = camera;
    return node;
}

function createShapePlayer(pcx, node, shapeName) {
    var shape = getShape(pcx, shapeName);
    node.shape = shapeName;
    var shapeObject = createShapeGeometry(pcx, shape.data, shapeName);
    node.threeObject.add(shapeObject);
    node.shapeObject = shapeObject;
    return node;
}

function createShapeGeometry(pcx, data, shapeName) {
    var shape = new THREE.Shape();
    shape.moveTo(data.points[0].x, data.points[0].y);
    for (var i = 1; i < data.points.length; i++) {
        shape.lineTo(data.points[i].x, data.points[i].y);
    }
    var shapeGeom = new THREE.ShapeBufferGeometry(shape);
    var mesh = new THREE.Mesh(shapeGeom, pcx.wallMaterial);
    if (data.pos)
        mesh.position.set(data.pos.x, data.pos.y, data.pos.z);
    mesh.shape = shapeName;
    var quat = new THREE.Quaternion();
    quat.set(data.rot.x, data.rot.y, data.rot.z, data.rot.w);
    mesh.applyQuaternion(quat);
    return mesh;
}

function findCamera(pcx, cameraId, startNode) {
    if (!startNode)
        startNode = pcx.sceneTree;
    if (!startNode)
        return null;
    var found = null;
    if (cameraId !== undefined && startNode.cameraId !== undefined && startNode.cameraId == cameraId)
        return startNode;
    startNode.children.forEach(function(node) {
        var foundSub = findCamera(pcx, cameraId, node);
        if (foundSub)
            found = foundSub;
    });
    return found;
}

function getKeyframe(pcx, time) {
    var found = null;
    if (!pcx.keyframes)
        return null;
    pcx.keyframes.forEach(function(keyframe) {
        if (keyframe.time == time)
            found = keyframe
    });
    return found;
}

function getKeyframeBefore(pcx, time, nodeId, dataType, hasCamera) {
    var found = null;
    var foundData = null;
    (pcx.keyframes || []).forEach(function(keyframe) {
        var data = getKeyframeData(keyframe, nodeId);
        if ((data != null && data[dataType] !== undefined) || hasCamera) {
            if (!hasCamera || keyframe.cameraId !== undefined) {
                if (keyframe.time < time) {
                    if (found == null) {
                        found = keyframe;
                        foundData = data;
                    }
                    else if (found.time < keyframe.time) {
                        found = keyframe;
                        foundData = data;
                    }
                }
            }
        }
    });
    return {kf: found, data: foundData};
}

function getKeyframeAfter(pcx, time, nodeId, dataType) {
    var found = null;
    var foundData = null;
    (pcx.keyframes || []).forEach(function(keyframe) {
        var data = getKeyframeData(keyframe, nodeId);
        if (data != null && data[dataType] !== undefined) {
            if (keyframe.time > time) {
                if (found == null) {
                    found = keyframe;
                    foundData = data;
                }
                else if (found.time > keyframe.time) {
                    found = keyframe;
                    foundData = data;
                }
            }
        }
    });
    return {kf: found, data: foundData};
}

function getKeyframeData(kf, nodeId) {
    var found = null;
    if (kf == null || !kf.nodes)
        return null;
    kf.nodes.forEach(function(nodeData) {
        if (nodeData.id == nodeId)
            found = nodeData;
    });
    return found;
}

// A camera node is only usable for rendering if it actually has a three.js
// camera object attached.
function isUsableCamera(camera) {
    return camera != null && camera.cameraObject != null;
}

// Camera selection used by both the player and the editor viewport.
// Order: exact keyframe camera, nearest earlier keyframe with a camera,
// then the default camera (cameraId 0).
function getKeyframeCamera(pcx, time) {
    var kf = getKeyframe(pcx, time);
    if (kf != null && kf.cameraId !== undefined) {
        var exact = findCamera(pcx, kf.cameraId);
        if (isUsableCamera(exact))
            return exact;
    }
    var candidates = [];
    (pcx.keyframes || []).forEach(function(keyframe) {
        if (keyframe.cameraId !== undefined && keyframe.time < time)
            candidates.push(keyframe);
    });
    candidates.sort(function(a, b) {
        return b.time - a.time;
    });
    for (var i = 0; i < candidates.length; i++) {
        var camera = findCamera(pcx, candidates[i].cameraId);
        if (isUsableCamera(camera))
            return camera;
    }
    return findCamera(pcx, 0);
}

function findCameraOrDefault(pcx, cameraId) {
    var camera = findCamera(pcx, cameraId);
    if (!isUsableCamera(camera))
        camera = findCamera(pcx, 0);
    return camera;
}

// Camera used by an editor viewport. followsKeyframes means the viewport
// follows the keyframe camera and therefore uses the same fallback rule as
// the player.
function getViewportCamera(pcx, cameraId, followsKeyframes, time) {
    var camera = followsKeyframes ? getKeyframeCamera(pcx, time) : findCameraOrDefault(pcx, cameraId);
    if (!isUsableCamera(camera))
        camera = findCamera(pcx, 0);
    return camera;
}

// Render only when a usable camera (with a cameraObject) was resolved.
function renderWithCamera(renderer, scene, camera) {
    if (renderer == null || camera == null || camera.cameraObject == null)
        return false;
    renderer.render(scene, camera.cameraObject);
    return true;
}

// Render an editor viewport that looks through a scene camera. Keeps the
// existing FOV/aspect-ratio update behavior, and skips rendering instead of
// dereferencing a missing camera.
function renderCameraViewport(pcx, viewport, followsKeyframes, time) {
    var camera = getViewportCamera(pcx, viewport.cameraId, followsKeyframes, time);
    if (!isUsableCamera(camera))
        return false;
    var ar = getAspectRatio(pcx.settings.aspectRatio);
    if (camera.cameraObject.fov != camera.cameraFov ||
        camera.cameraObject.aspect != ar) {
        camera.cameraObject.fov = camera.cameraFov;
        camera.cameraObject.aspect = ar;
        camera.cameraObject.updateProjectionMatrix();
    }
    return renderWithCamera(viewport.renderer, pcx.scene, camera);
}

function seekTimePlayer(pcx, time) {
    var kf = getKeyframe(pcx, time);
    traverseTree(pcx, function(node) {
        var current = getKeyframeData(kf, node.id);
        var currentPos = null;
        var currentRot = null;
        var currentScale = null;
        var currentVis = null;
        if (current) {
            currentPos = current.pos;
            currentRot = current.rot;
            currentScale = current.scale;
            currentVis = current.vis;
        }
        if (currentPos)
            node.threeObject.position.set(currentPos.x, currentPos.y, currentPos.z);
        if (currentRot)
            node.threeObject.quaternion.set(currentRot.x, currentRot.y, currentRot.z, currentRot.w);
        if (currentScale)
            node.threeObject.scale.set(currentScale.x, currentScale.y, currentScale.z);
        if (currentVis == false) {
            node.threeObject.children.forEach(function(child) {
                if (child.model) {
                    child.visible = false;
                    child.vis = false;
                }
            });
        }
        else if (currentVis == true) {
            node.threeObject.children.forEach(function(child) {
                if (child.model) {
                    child.visible = true;
                    child.vis = true;
                }
            });
        }
        if (currentPos && currentRot && currentScale && currentVis != null) {
            node.threeObject.quaternion.normalize();
            return;
        }
        var beforePos = getKeyframeBefore(pcx, time, node.id, 'pos');
        var beforeRot = getKeyframeBefore(pcx, time, node.id, 'rot');
        var beforeScale = getKeyframeBefore(pcx, time, node.id, 'scale');
        var beforeVis = getKeyframeBefore(pcx, time, node.id, 'vis');
        var afterPos = getKeyframeAfter(pcx, time, node.id, 'pos');
        var afterRot = getKeyframeAfter(pcx, time, node.id, 'rot');
        var afterScale = getKeyframeAfter(pcx, time, node.id, 'scale');
        if (beforeVis.data && beforeVis.data.vis == false && currentVis == null) {
            node.threeObject.children.forEach(function(child) {
                if (child.model) {
                    child.visible = false;
                    child.vis = false;
                }
            });
        }
        else if (beforeVis.data && beforeVis.data.vis == true && currentVis == null) {
            node.threeObject.children.forEach(function(child) {
                if (child.model) {
                    child.visible = true;
                    child.vis = true;
                }
            });
        }
        if (afterPos.data && !beforePos.data && !currentPos)
            node.threeObject.position.set(afterPos.data.pos.x, afterPos.data.pos.y, afterPos.data.pos.z);
        if (afterRot.data && !beforeRot.data && !currentRot)
            node.threeObject.quaternion.set(afterRot.data.rot.x, afterRot.data.rot.y, afterRot.data.rot.z, afterRot.data.rot.w);
        if (afterScale.data && !beforeScale.data && !currentScale)
            node.threeObject.scale.set(afterScale.data.scale.x, afterScale.data.scale.y, afterScale.data.scale.z);
        if (beforePos.data && !afterPos.data && !currentPos)
            node.threeObject.position.set(beforePos.data.pos.x, beforePos.data.pos.y, beforePos.data.pos.z);
        if (beforeRot.data && !afterRot.data && !currentRot)
            node.threeObject.quaternion.set(beforeRot.data.rot.x, beforeRot.data.rot.y, beforeRot.data.rot.z, beforeRot.data.rot.w);
        if (beforeScale.data && !afterScale.data && !currentScale)
            node.threeObject.scale.set(beforeScale.data.scale.x, beforeScale.data.scale.y, beforeScale.data.scale.z);
        if (beforePos.data && afterPos.data && !currentPos) {
            var alpha = (time - beforePos.kf.time) / (afterPos.kf.time - beforePos.kf.time);
            var posBefore = new THREE.Vector3(beforePos.data.pos.x, beforePos.data.pos.y, beforePos.data.pos.z);
            var posAfter = new THREE.Vector3(afterPos.data.pos.x, afterPos.data.pos.y, afterPos.data.pos.z);
            var pos = new THREE.Vector3();
            pos.lerpVectors(posBefore, posAfter, alpha);
            node.threeObject.position.set(pos.x, pos.y, pos.z);
        }
        if (beforeRot.data && afterRot.data && !currentRot) {
            var alpha = (time - beforeRot.kf.time) / (afterRot.kf.time - beforeRot.kf.time);
            var rotBefore = new THREE.Quaternion(beforeRot.data.rot.x, beforeRot.data.rot.y, beforeRot.data.rot.z, beforeRot.data.rot.w);
            var rotAfter = new THREE.Quaternion(afterRot.data.rot.x, afterRot.data.rot.y, afterRot.data.rot.z, afterRot.data.rot.w);
            var rot = new THREE.Quaternion();
            rotBefore.normalize();
            rotAfter.normalize();
            THREE.Quaternion.slerp(rotBefore, rotAfter, rot, alpha);
            node.threeObject.setRotationFromQuaternion(rot);

        }
        if (afterScale.data && beforeScale.data && !currentScale) {
            var alpha = (time - beforeScale.kf.time) / (afterScale.kf.time - beforeScale.kf.time);
            var xs = beforeScale.data.scale.x + ((afterScale.data.scale.x - beforeScale.data.scale.x) * alpha);
            var ys = beforeScale.data.scale.y + ((afterScale.data.scale.y - beforeScale.data.scale.y) * alpha);
            var zs = beforeScale.data.scale.z + ((afterScale.data.scale.z - beforeScale.data.scale.z) * alpha);
            node.threeObject.scale.set(xs, ys, zs);
        }
        node.threeObject.quaternion.normalize();
    });
    var cameraNode = getKeyframeCamera(pcx, time);
    // Never leave the caller without a usable camera for rendering.
    if (!isUsableCamera(cameraNode))
        cameraNode = findCamera(pcx, 0);
    return cameraNode;
}

function playPlayer(player) {
    var pcx = getContext(player);
    if (pcx.time == pcx.settings.length) {
        pcx.time = 0;
        clearInterval(pcx.timerId);
    }
    if (pcx.timerId != -1)
        return;
    pcx.timerId = setInterval(function() {
        var pcx = getContext(player);
        var camera = seekTimePlayer(pcx, pcx.time);
        pcx.time = pcx.time + 1;
        if (pcx.time > pcx.settings.length - 1) {
            if (pcx.settings.loop) {
                pcx.time = 0;
            }
            else {
                clearInterval(pcx.timerId);
                pcx.timerId = -1;
                pcx.time = 0;
                return;
            }
        }
        
        renderWithCamera(pcx.renderer, pcx.scene, camera);
    }, 1000 / pcx.settings.framerate);
}

function pausePlayer(player) {
    var pcx = getContext(player);
    if (pcx.timerId != -1) {
        clearInterval(pcx.timerId);
        pcx.timerId = -1;
    }
}

function togglePlayPausePlayer(player) {
    var pcx = getContext(player);
    if (pcx.timerId == -1)
        playPlayer(player);
    else
        pausePlayer(player);
}
