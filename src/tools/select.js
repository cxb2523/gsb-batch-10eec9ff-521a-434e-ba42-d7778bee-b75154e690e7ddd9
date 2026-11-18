// src/tools/select.js

function _getSelectionGeometry() {
    try {
        if (typeof VexelSelectionGeometry !== 'undefined') return VexelSelectionGeometry;
    } catch (e) {
        // Lexical binding may still be in its TDZ if this script loads first.
    }
    if (typeof globalThis !== 'undefined' && globalThis.VexelSelectionGeometry) {
        return globalThis.VexelSelectionGeometry;
    }
    if (typeof require === 'function') return require('./selection-geometry');
    return null;
}

class VexelSelectTool {
    get geometry() {
        return _getSelectionGeometry();
    }
    constructor(vexel) {
        this.vexel = vexel;
        this.active = false;
        this.dragging = false;
        this.resizing = false;
        this.rotating = false;
        this.marquee = false;
        this.marqueeStart = null;
        this.marqueeEnd = null;
        this.dragStart = null;
        this.dragOffset = { x: 0, y: 0 };
        this.dragStartPositions = new Map();
        this.resizeHandle = null;
        this.resizeStartBounds = null;
        this.resizeStartPoint = null;
        this.resizeParticipants = [];
        this.rotateStart = null;
        this.rotateCenter = null;
        this.rotateStartAngle = 0;
        this.rotateStartRotation = 0;
        this.handleSize = 8;
        this.handles = [];
        this.hoveredHandle = null;
        this.hitTolerance = 5;
    }

    activate() {
        this.active = true;
        this._bindEvents();
    }

    deactivate() {
        this.active = false;
        this._unbindEvents();
        this.vexel.deselectAll();
    }

    _bindEvents() {
        this._onMouseDown = this._handleMouseDown.bind(this);
        this._onMouseMove = this._handleMouseMove.bind(this);
        this._onMouseUp = this._handleMouseUp.bind(this);
        this._onKeyDown = this._handleKeyDown.bind(this);

        this.vexel.container.addEventListener('mousedown', this._onMouseDown);
        window.addEventListener('mousemove', this._onMouseMove);
        window.addEventListener('mouseup', this._onMouseUp);
        window.addEventListener('keydown', this._onKeyDown);
    }

    _unbindEvents() {
        this.vexel.container.removeEventListener('mousedown', this._onMouseDown);
        window.removeEventListener('mousemove', this._onMouseMove);
        window.removeEventListener('mouseup', this._onMouseUp);
        window.removeEventListener('keydown', this._onKeyDown);
    }

    _getCanvasPoint(e) {
        const rect = this.vexel.container.getBoundingClientRect();
        return {
            x: (e.clientX - rect.left - this.vexel.viewport.x) / this.vexel.viewport.zoom,
            y: (e.clientY - rect.top - this.vexel.viewport.y) / this.vexel.viewport.zoom
        };
    }

    _getZoom() {
        const zoom = this.vexel.viewport && this.vexel.viewport.zoom;
        return zoom > 0 ? zoom : 1;
    }

    /**
     * Lock state lives on VexelSceneNode; shape objects may not carry a
     * `locked` flag at all. Ask the Vexel instance to resolve the scene node
     * association first (that is the authoritative source), then fall back to
     * the shape's own flag. When no association exists the shape is explicitly
     * treated as unlocked.
     */
    _isShapeLocked(shape) {
        if (!shape) return false;
        if (this.vexel && typeof this.vexel.isShapeLocked === 'function') {
            return this.vexel.isShapeLocked(shape) === true;
        }
        return shape.locked === true;
    }

    getSelectionBounds() {
        const selected = this.vexel.selectedShapes || [];
        return _getSelectionGeometry().selectionBounds(selected);
    }

    /** Screen-space hit radius converted to canvas units for the current zoom. */
    _hitRadius(screenPixels) {
        return screenPixels / this._getZoom();
    }

    _handleMouseDown(e) {
        if (!this.active || e.button !== 0) return;

        const point = this._getCanvasPoint(e);

        if (e.shiftKey) {
            this.marquee = true;
            this.marqueeStart = point;
            this.marqueeEnd = point;
            return;
        }

        const selectionBounds = this.getSelectionBounds();

        if (selectionBounds) {
            const handle = _getSelectionGeometry().hitTestHandle(
                point,
                selectionBounds,
                this._hitRadius(this.handleSize + this.hitTolerance)
            );
            if (handle) {
                // A handle was grabbed: either start scaling the unlocked
                // participants, or consume the click when every selected shape
                // is locked (locked geometry must never change).
                this._startResize(handle, point);
                return;
            }
        }

        if (this.vexel.selectedShapes.length === 1 && this._isNearRotationHandle(point)) {
            this._startRotate(point);
            return;
        }

        const hitShape = this._hitTest(point);

        if (hitShape) {
            if (!this.vexel.selectedShapes.includes(hitShape)) {
                if (!e.metaKey && !e.ctrlKey) {
                    this.vexel.deselectAll();
                }
                this.vexel.select(hitShape);
            }
            this._startDrag(point);
        } else {
            if (!e.metaKey && !e.ctrlKey) {
                this.vexel.deselectAll();
            }
            this.marquee = true;
            this.marqueeStart = point;
            this.marqueeEnd = point;
        }
    }

    _handleMouseMove(e) {
        const point = this._getCanvasPoint(e);

        if (this.dragging) {
            const dx = point.x - this.dragStart.x;
            const dy = point.y - this.dragStart.y;

            for (const shape of this.vexel.selectedShapes) {
                if (!this._isShapeLocked(shape)) {
                    const start = this.dragOffset[shape.id];
                    if (!start) continue;
                    shape.x = start.x + dx;
                    shape.y = start.y + dy;

                    if (this.vexel.snapEnabled) {
                        shape.x = Math.round(shape.x / this.vexel.snapSize) * this.vexel.snapSize;
                        shape.y = Math.round(shape.y / this.vexel.snapSize) * this.vexel.snapSize;
                    }
                }
            }
            this.vexel.dirty = true;
            return;
        }

        if (this.resizing) {
            this._updateResize(point);
            return;
        }

        if (this.rotating && this.vexel.selectedShapes.length === 1) {
            this._updateRotate(point);
            return;
        }

        if (this.marquee) {
            this.marqueeEnd = point;
            this.vexel.dirty = true;
            return;
        }

        this._updateHoveredHandle(point);
        this._updateCursor(point);
    }

    _handleMouseUp(e) {
        if (this.marquee) {
            this._finishMarquee();
            this.marquee = false;
            this.marqueeStart = null;
            this.marqueeEnd = null;
        }

        if (this.dragging) {
            this._finishDrag();
        }

        if (this.resizing) {
            this._finishResize();
        }

        if (this.rotating) {
            this._finishRotate();
        }

        this.dragging = false;
        this.resizing = false;
        this.rotating = false;
        this.dragStart = null;
        this.dragStartPositions = new Map();
        this.resizeHandle = null;
        this.resizeStartBounds = null;
        this.resizeStartPoint = null;
        this.resizeParticipants = [];
        this.rotateStart = null;
    }

    _handleKeyDown(e) {
        if (!this.active) return;

        const step = e.shiftKey ? 10 : 1;

        switch (e.key) {
            case 'Delete':
            case 'Backspace':
                this.vexel.deleteSelected();
                break;
            case 'Escape':
                this.vexel.deselectAll();
                break;
            case 'a':
                if (e.metaKey || e.ctrlKey) {
                    e.preventDefault();
                    this.vexel.selectAll();
                }
                break;
            case 'ArrowLeft':
                this._nudge(-step, 0);
                break;
            case 'ArrowRight':
                this._nudge(step, 0);
                break;
            case 'ArrowUp':
                this._nudge(0, -step);
                break;
            case 'ArrowDown':
                this._nudge(0, step);
                break;
            case 'd':
                if (e.metaKey || e.ctrlKey) {
                    e.preventDefault();
                    this._duplicate();
                }
                break;
        }
    }

    _nudge(dx, dy) {
        for (const shape of this.vexel.selectedShapes) {
            if (!this._isShapeLocked(shape)) {
                shape.x += dx;
                shape.y += dy;
            }
        }
        this.vexel.dirty = true;
    }

    _duplicate() {
        const newShapes = [];
        for (const shape of this.vexel.selectedShapes) {
            const cloned = shape.clone();
            cloned.x += 20;
            cloned.y += 20;
            cloned.id = cloned._generateId();
            this.vexel.shapes.push(cloned);
            newShapes.push(cloned);
        }
        this.vexel.deselectAll();
        for (const shape of newShapes) {
            this.vexel.select(shape);
        }
        this.vexel.dirty = true;
    }

    _hitTest(point) {
        for (let i = this.vexel.shapes.length - 1; i >= 0; i--) {
            const shape = this.vexel.shapes[i];
            if (shape.visible === false || this._isShapeLocked(shape)) continue;

            if (typeof shape.containsPoint === 'function') {
                if (shape.containsPoint(point.x, point.y)) return shape;
                continue;
            }

            // Legacy shape classes only expose getBounds(); hit-test those.
            if (typeof shape.getBounds === 'function') {
                const b = shape.getBounds();
                if (
                    point.x >= b.x && point.x <= b.x + b.width &&
                    point.y >= b.y && point.y <= b.y + b.height
                ) {
                    return shape;
                }
            }
        }
        return null;
    }

    _startDrag(point) {
        this.dragging = true;
        this.dragStart = point;
        this.dragOffset = {};
        this.dragStartPositions = new Map();

        for (const shape of this.vexel.selectedShapes) {
            this.dragOffset[shape.id] = { x: shape.x, y: shape.y };
            this.dragStartPositions.set(shape.id, { x: shape.x, y: shape.y });
        }
    }

    _finishDrag() {
        const positions = [];
        const previousPositions = [];

        for (const shape of this.vexel.selectedShapes) {
            const start = this.dragStartPositions.get(shape.id);
            if (!start) continue;
            if (start.x !== shape.x || start.y !== shape.y) {
                positions.push({ id: shape.id, x: shape.x, y: shape.y });
                previousPositions.push({ id: shape.id, x: start.x, y: start.y });
            }
        }

        if (positions.length > 0) {
            this._recordHistory({
                type: 'move-shapes',
                positions,
                previousPositions
            });
        }

        this.dragging = false;
        this.dragStart = null;
        this.dragOffset = {};
        this.dragStartPositions = new Map();
    }

    _recordHistory(action) {
        const history = this.vexel && this.vexel.history;

        // VexelHistory instances keep their own undo/redo stacks and already
        // de-duplicate batched actions; the plain history object on Vexel is
        // handled by _pushHistory.
        if (history && Array.isArray(history.undoStack) && typeof history.push === 'function') {
            history.push(action);
            return;
        }

        if (this.vexel && typeof this.vexel._pushHistory === 'function') {
            this.vexel._pushHistory(action);
        }
    }

    /**
     * Start a resize of the union bounds of every selected shape. Locked shapes
     * stay in the selection (and in the union bounds they define) but are
     * excluded from `resizeParticipants`, so they keep their geometry while the
     * rest scale about the union anchor.
     *
     * Returns false when there is nothing that can be scaled.
     */
    _startResize(handle, point) {
        const selected = this.vexel.selectedShapes || [];
        const bounds = this.getSelectionBounds();

        if (!bounds || selected.length === 0) return false;

        const participants = [];
        for (const shape of selected) {
            if (this._isShapeLocked(shape)) continue;
            participants.push({
                shape,
                snapshot: _getSelectionGeometry().captureGeometry(shape)
            });
        }

        if (participants.length === 0) return false;

        this.resizing = true;
        this.resizeHandle = handle;
        this.resizeStartBounds = { ...bounds };
        this.resizeStartPoint = point;
        this.resizeParticipants = participants;
        return true;
    }

    _updateResize(point) {
        const startBounds = this.resizeStartBounds;
        if (!startBounds) return;

        const handle = this.resizeHandle;
        const dx = point.x - this.resizeStartPoint.x;
        const dy = point.y - this.resizeStartPoint.y;

        const targetBounds = _getSelectionGeometry().targetBoundsForHandle(
            handle,
            startBounds,
            dx,
            dy,
            1
        );

        const scaleX = startBounds.width > 0 ? targetBounds.width / startBounds.width : 1;
        const scaleY = startBounds.height > 0 ? targetBounds.height / startBounds.height : 1;
        const anchor = _getSelectionGeometry().anchorForHandle(handle, startBounds);

        for (const participant of this.resizeParticipants) {
            const { shape, snapshot } = participant;
            const shapeBounds = snapshot.bounds;

            const target = {
                x: anchor.x + (shapeBounds.x - anchor.x) * scaleX,
                y: anchor.y + (shapeBounds.y - anchor.y) * scaleY,
                width: shapeBounds.width * scaleX,
                height: shapeBounds.height * scaleY,
                scaleX,
                scaleY,
                anchor
            };

            _getSelectionGeometry().applyBounds(shape, snapshot, target);
        }

        this.vexel.dirty = true;
    }

    _finishResize() {
        if (this.resizeParticipants.length > 0) {
            const changes = [];
            const previous = [];

            for (const participant of this.resizeParticipants) {
                const { shape, snapshot } = participant;
                const originalBounds = snapshot.bounds;
                const currentBounds = shape.getBounds();

                if (
                    originalBounds.x !== currentBounds.x ||
                    originalBounds.y !== currentBounds.y ||
                    originalBounds.width !== currentBounds.width ||
                    originalBounds.height !== currentBounds.height
                ) {
                    changes.push({
                        id: shape.id,
                        bounds: { ...currentBounds },
                        state: _getSelectionGeometry().captureState(shape)
                    });
                    previous.push({
                        id: shape.id,
                        bounds: { ...originalBounds },
                        state: snapshot.state
                    });
                }
            }

            if (changes.length > 0) {
                // A single history entry covers the entire drag, so undo
                // restores every participating shape at once.
                this._recordHistory({
                    type: 'transform-shapes',
                    shapes: changes,
                    previousShapes: previous
                });
            }
        }

        this.resizing = false;
        this.resizeHandle = null;
        this.resizeStartBounds = null;
        this.resizeStartPoint = null;
        this.resizeParticipants = [];
    }

    _startRotate(point) {
        const shape = this.vexel.selectedShapes[0];
        const bounds = shape.getBounds();
        this.rotating = true;
        this.rotateCenter = {
            x: bounds.x + bounds.width / 2,
            y: bounds.y + bounds.height / 2
        };
        this.rotateStart = point;
        this.rotateStartAngle = Math.atan2(
            point.y - this.rotateCenter.y,
            point.x - this.rotateCenter.x
        );
        this.rotateStartRotation = shape.rotation;
    }

    _updateRotate(point) {
        const shape = this.vexel.selectedShapes[0];
        const angle = Math.atan2(
            point.y - this.rotateCenter.y,
            point.x - this.rotateCenter.x
        );
        let rotation = (angle - this.rotateStartAngle) * (180 / Math.PI);
        rotation = this.rotateStartRotation + rotation;

        if (this.vexel.snapEnabled) {
            rotation = Math.round(rotation / 15) * 15;
        }

        shape.rotation = rotation % 360;
        this.vexel.dirty = true;
    }

    _finishRotate() {
        this.rotating = false;
        this.rotateStart = null;
        this.rotateCenter = null;
    }

    _isNearRotationHandle(point) {
        if (this.vexel.selectedShapes.length !== 1) return false;
        const shape = this.vexel.selectedShapes[0];
        const bounds = shape.getBounds();
        const zoom = this._getZoom();
        const cx = bounds.x + bounds.width / 2;
        const cy = bounds.y - 30 / zoom;
        const dist = Math.sqrt((point.x - cx) ** 2 + (point.y - cy) ** 2);
        return dist < 15 / zoom;
    }

    _updateHoveredHandle(point) {
        const bounds = this.getSelectionBounds();
        if (!bounds) {
            this.hoveredHandle = null;
            return;
        }

        this.hoveredHandle = _getSelectionGeometry().hitTestHandle(
            point,
            bounds,
            this._hitRadius(this.handleSize + this.hitTolerance)
        );
    }

    _updateCursor(point) {
        if (this.hoveredHandle) {
            const cursors = {
                nw: 'nwse-resize',
                se: 'nwse-resize',
                ne: 'nesw-resize',
                sw: 'nesw-resize',
                n: 'ns-resize',
                s: 'ns-resize',
                w: 'ew-resize',
                e: 'ew-resize'
            };
            this.vexel.container.style.cursor = cursors[this.hoveredHandle] || 'default';
            return;
        }

        if (this.vexel.selectedShapes.length === 1 && this._isNearRotationHandle(point)) {
            this.vexel.container.style.cursor = 'grab';
            return;
        }

        const hitShape = this._hitTest(point);
        this.vexel.container.style.cursor = hitShape ? 'move' : 'default';
    }

    _finishMarquee() {
        if (!this.marqueeStart || !this.marqueeEnd) return;

        const x1 = Math.min(this.marqueeStart.x, this.marqueeEnd.x);
        const y1 = Math.min(this.marqueeStart.y, this.marqueeEnd.y);
        const x2 = Math.max(this.marqueeStart.x, this.marqueeEnd.x);
        const y2 = Math.max(this.marqueeStart.y, this.marqueeEnd.y);

        const selected = [];
        for (const shape of this.vexel.shapes) {
            if (shape.visible !== false && !this._isShapeLocked(shape)) {
                const bounds = shape.getBounds();
                if (
                    bounds.x + bounds.width >= x1 &&
                    bounds.x <= x2 &&
                    bounds.y + bounds.height >= y1 &&
                    bounds.y <= y2
                ) {
                    selected.push(shape);
                }
            }
        }

        this.vexel.deselectAll();
        for (const shape of selected) {
            this.vexel.select(shape);
        }
    }

    drawMarquee(ctx) {
        if (!this.marquee || !this.marqueeStart || !this.marqueeEnd) return;

        const x = Math.min(this.marqueeStart.x, this.marqueeEnd.x);
        const y = Math.min(this.marqueeStart.y, this.marqueeEnd.y);
        const w = Math.abs(this.marqueeEnd.x - this.marqueeStart.x);
        const h = Math.abs(this.marqueeEnd.y - this.marqueeStart.y);

        ctx.save();
        ctx.translate(this.vexel.viewport.x, this.vexel.viewport.y);
        ctx.scale(this.vexel.viewport.zoom, this.vexel.viewport.zoom);

        ctx.fillStyle = 'rgba(74, 144, 217, 0.1)';
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = '#4A90D9';
        ctx.lineWidth = 1 / this.vexel.viewport.zoom;
        ctx.setLineDash([4, 4]);
        ctx.strokeRect(x, y, w, h);
        ctx.setLineDash([]);

        ctx.restore();
    }

    drawRotationHandle(ctx) {
        if (this.vexel.selectedShapes.length !== 1) return;

        const shape = this.vexel.selectedShapes[0];
        const bounds = shape.getBounds();
        const cx = bounds.x + bounds.width / 2;
        const cy = bounds.y - 30;

        ctx.save();
        ctx.translate(this.vexel.viewport.x, this.vexel.viewport.y);
        ctx.scale(this.vexel.viewport.zoom, this.vexel.viewport.zoom);

        ctx.strokeStyle = '#4A90D9';
        ctx.lineWidth = 1.5 / this.vexel.viewport.zoom;
        ctx.setLineDash([2, 2]);
        ctx.beginPath();
        ctx.moveTo(bounds.x + bounds.width / 2, bounds.y);
        ctx.lineTo(cx, cy);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = '#4A90D9';
        ctx.lineWidth = 1.5 / this.vexel.viewport.zoom;
        ctx.beginPath();
        ctx.arc(cx, cy, 6 / this.vexel.viewport.zoom, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = '#4A90D9';
        ctx.beginPath();
        ctx.arc(cx, cy, 2 / this.vexel.viewport.zoom, 0, Math.PI * 2);
        ctx.fill();

        ctx.restore();
    }
}

if (typeof window !== 'undefined') {
    window.VexelSelectTool = VexelSelectTool;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = VexelSelectTool;
}