// src/tools/selection-geometry.js
//
// Shared geometry helpers for selection frames and multi-selection scaling.
// Everything in this file is pure math over plain objects, so it can be used
// by the select tool and the renderers without touching the DOM.

class VexelSelectionGeometry {
    static isBoundsLike(bounds) {
        return !!bounds &&
            Number.isFinite(bounds.x) &&
            Number.isFinite(bounds.y) &&
            Number.isFinite(bounds.width) &&
            Number.isFinite(bounds.height);
    }

    static unionBounds(boundsList) {
        const list = (boundsList || []).filter(b => VexelSelectionGeometry.isBoundsLike(b));
        if (list.length === 0) return null;

        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;

        for (const b of list) {
            minX = Math.min(minX, b.x);
            minY = Math.min(minY, b.y);
            maxX = Math.max(maxX, b.x + b.width);
            maxY = Math.max(maxY, b.y + b.height);
        }

        return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    }

    static selectionBounds(shapes) {
        if (!shapes || shapes.length === 0) return null;

        const boundsList = [];
        for (const shape of shapes) {
            if (!shape || typeof shape.getBounds !== 'function') continue;
            const bounds = shape.getBounds();
            if (bounds) boundsList.push(bounds);
        }

        return VexelSelectionGeometry.unionBounds(boundsList);
    }

    static handlePositions(bounds) {
        if (!VexelSelectionGeometry.isBoundsLike(bounds)) return {};

        const { x, y, width, height } = bounds;
        return {
            nw: { x, y },
            n: { x: x + width / 2, y },
            ne: { x: x + width, y },
            e: { x: x + width, y: y + height / 2 },
            se: { x: x + width, y: y + height },
            s: { x: x + width / 2, y: y + height },
            sw: { x, y: y + height },
            w: { x, y: y + height / 2 }
        };
    }

    static hitTestHandle(point, bounds, tolerance) {
        if (!point || !VexelSelectionGeometry.isBoundsLike(bounds)) return null;

        const handles = VexelSelectionGeometry.handlePositions(bounds);
        let best = null;
        let bestDistance = Infinity;

        for (const [key, pos] of Object.entries(handles)) {
            const distance = Math.hypot(point.x - pos.x, point.y - pos.y);
            if (distance <= tolerance && distance < bestDistance) {
                best = key;
                bestDistance = distance;
            }
        }

        return best;
    }

    /**
     * Fixed point of the union bounds for a given handle. The opposite corner
     * (or edge) stays put while dragging, which is also what makes the union
     * top-left the anchor when dragging the `se` handle.
     */
    static anchorForHandle(handle, bounds) {
        const { x, y, width, height } = bounds;

        switch (handle) {
            case 'nw': return { x: x + width, y: y + height };
            case 'ne': return { x, y: y + height };
            case 'sw': return { x: x + width, y };
            case 'se': return { x, y };
            case 'n': return { x, y: y + height };
            case 's': return { x, y };
            case 'w': return { x: x + width, y };
            case 'e': return { x, y };
            default: return { x, y };
        }
    }

    /**
     * Bounds the union selection box should have after dragging `handle` by
     * (dx, dy) canvas units. Sizes are clamped to `minSize` without letting
     * the anchored edge cross over.
     */
    static targetBoundsForHandle(handle, startBounds, dx, dy, minSize = 1) {
        const start = startBounds;
        const anchor = VexelSelectionGeometry.anchorForHandle(handle, start);
        const right = start.x + start.width;
        const bottom = start.y + start.height;

        let x = start.x;
        let y = start.y;
        let width = start.width;
        let height = start.height;

        switch (handle) {
            case 'nw':
                width = Math.max(minSize, start.width - dx);
                height = Math.max(minSize, start.height - dy);
                x = anchor.x - width;
                y = anchor.y - height;
                break;
            case 'ne':
                width = Math.max(minSize, start.width + dx);
                height = Math.max(minSize, start.height - dy);
                x = start.x;
                y = anchor.y - height;
                break;
            case 'sw':
                width = Math.max(minSize, start.width - dx);
                height = Math.max(minSize, start.height + dy);
                x = anchor.x - width;
                y = start.y;
                break;
            case 'se':
                width = Math.max(minSize, start.width + dx);
                height = Math.max(minSize, start.height + dy);
                break;
            case 'n':
                height = Math.max(minSize, start.height - dy);
                width = right - x;
                y = anchor.y - height;
                break;
            case 's':
                height = Math.max(minSize, start.height + dy);
                width = right - x;
                break;
            case 'w':
                width = Math.max(minSize, start.width - dx);
                height = bottom - y;
                x = anchor.x - width;
                break;
            case 'e':
                width = Math.max(minSize, start.width + dx);
                height = bottom - y;
                break;
        }

        return { x, y, width, height };
    }

    /**
     * Scale one rectangle of geometry with the union box transform. Positions
     * are taken relative to the handle's fixed anchor, so every shape moves
     * and grows by the same ratio as the union.
     */
    static scaleRect(rect, startBounds, targetBounds, handle) {
        const anchor = VexelSelectionGeometry.anchorForHandle(handle, startBounds);
        const scaleX = startBounds.width > 0 ? targetBounds.width / startBounds.width : 1;
        const scaleY = startBounds.height > 0 ? targetBounds.height / startBounds.height : 1;

        return {
            x: anchor.x + (rect.x - anchor.x) * scaleX,
            y: anchor.y + (rect.y - anchor.y) * scaleY,
            width: rect.width * scaleX,
            height: rect.height * scaleY,
            scaleX,
            scaleY,
            anchor
        };
    }

    static captureState(shape) {
        const state = {};
        const keys = [
            'x', 'y', 'width', 'height',
            'scaleX', 'scaleY', 'rotation',
            'radiusX', 'radiusY', 'radius', 'fontSize'
        ];

        for (const key of keys) {
            if (shape[key] !== undefined) state[key] = shape[key];
        }

        if (Array.isArray(shape.points)) {
            state.points = shape.points.map(p => ({ x: p.x, y: p.y }));
        }

        if (shape.x1 !== undefined) {
            state.x1 = shape.x1;
            state.y1 = shape.y1;
            state.x2 = shape.x2;
            state.y2 = shape.y2;
        }

        if (shape.startPoint) state.startPoint = { ...shape.startPoint };
        if (shape.endPoint) state.endPoint = { ...shape.endPoint };
        if (Array.isArray(shape.waypoints)) {
            state.waypoints = shape.waypoints.map(p => ({ x: p.x, y: p.y }));
        }

        if (Array.isArray(shape.shapes)) {
            state.children = shape.shapes.map(child => ({
                id: child.id,
                state: VexelSelectionGeometry.captureState(child)
            }));
        }

        return state;
    }

    static restoreState(shape, state) {
        if (!shape || !state) return;

        for (const key of Object.keys(state)) {
            if (key === 'points') {
                shape.points = state.points.map(p => ({ x: p.x, y: p.y }));
            } else if (key === 'children' && Array.isArray(shape.shapes)) {
                state.children.forEach((childState, index) => {
                    const child = shape.shapes.find(s => s.id === childState.id) || shape.shapes[index];
                    if (child) VexelSelectionGeometry.restoreState(child, childState.state);
                });
            } else {
                shape[key] = state[key];
            }
        }

        VexelSelectionGeometry.invalidateBounds(shape);
    }

    static captureGeometry(shape) {
        return {
            id: shape.id,
            type: shape.type,
            bounds: { ...shape.getBounds() },
            state: VexelSelectionGeometry.captureState(shape),
            children: Array.isArray(shape.shapes)
                ? shape.shapes.map(child => VexelSelectionGeometry.captureGeometry(child))
                : null
        };
    }

    static invalidateBounds(shape) {
        if (!shape) return;

        // Different shape families use different cache flags; set all of the
        // ones that exist so getBounds() recomputes on the next read.
        if (shape._boundsDirty !== undefined) shape._boundsDirty = true;
        if (shape._dirty !== undefined) shape._dirty = true;
        if (shape._cachedBounds !== undefined) shape._cachedBounds = null;
    }

    /**
     * Apply a target rectangle (already scaled about the union anchor) to a
     * shape. Rectangle-like shapes keep their scale factors and receive an
     * explicit width/height; shape types with a different geometry model get
     * their natural parameters updated instead.
     */
    static applyBounds(shape, snapshot, target) {
        if (!shape || !snapshot || !target) return;

        // Only container shapes whose bounds are derived from their children
        // may recurse. Frames also hold a `shapes` array but size themselves.
        if (shape.type === 'group' && Array.isArray(shape.shapes) && snapshot.children) {
            // Group bounds are derived from children, so scale each child in
            // the same coordinate space and let getBounds() recompute.
            const scaleX = target.scaleX !== undefined ? target.scaleX : 1;
            const scaleY = target.scaleY !== undefined ? target.scaleY : 1;
            const anchor = target.anchor || { x: target.x, y: target.y };

            snapshot.children.forEach((childSnapshot, index) => {
                const child = shape.shapes.find(s => s.id === childSnapshot.id) || shape.shapes[index];
                if (!child) return;

                const childBounds = childSnapshot.bounds;
                const childTarget = {
                    x: anchor.x + (childBounds.x - anchor.x) * scaleX,
                    y: anchor.y + (childBounds.y - anchor.y) * scaleY,
                    width: childBounds.width * scaleX,
                    height: childBounds.height * scaleY,
                    scaleX,
                    scaleY,
                    anchor
                };
                VexelSelectionGeometry.applyBounds(child, childSnapshot, childTarget);
            });

            shape.x = target.x;
            shape.y = target.y;
            shape.width = target.width;
            shape.height = target.height;
            VexelSelectionGeometry.invalidateBounds(shape);
            return;
        }

        const scaleX = target.scaleX !== undefined ? target.scaleX : 1;
        const scaleY = target.scaleY !== undefined ? target.scaleY : 1;
        const anchor = target.anchor || { x: target.x, y: target.y };

        switch (shape.type) {
            case 'ellipse':
                shape.x = target.x + target.width / 2;
                shape.y = target.y + target.height / 2;
                shape.radiusX = target.width / 2;
                shape.radiusY = target.height / 2;
                return;

            case 'polygon': {
                const baseRadius = snapshot.state.radius !== undefined ? snapshot.state.radius : 0;
                const averageScale = (scaleX + scaleY) / 2;
                shape.x = target.x + target.width / 2;
                shape.y = target.y + target.height / 2;
                shape.radius = baseRadius * averageScale;
                return;
            }

            case 'line': {
                const state = snapshot.state;
                shape.x1 = anchor.x + (state.x1 - anchor.x) * scaleX;
                shape.y1 = anchor.y + (state.y1 - anchor.y) * scaleY;
                shape.x2 = anchor.x + (state.x2 - anchor.x) * scaleX;
                shape.y2 = anchor.y + (state.y2 - anchor.y) * scaleY;
                return;
            }

            case 'path': {
                const state = snapshot.state;
                if (Array.isArray(state.points)) {
                    shape.points = state.points.map(p => ({
                        x: anchor.x + (p.x - anchor.x) * scaleX,
                        y: anchor.y + (p.y - anchor.y) * scaleY
                    }));
                }
                return;
            }

            case 'connector': {
                // Anchored connectors follow their target shapes; only
                // standalone endpoints can be transformed here.
                if (shape.startPoint) {
                    shape.startPoint = {
                        x: anchor.x + (shape.startPoint.x - anchor.x) * scaleX,
                        y: anchor.y + (shape.startPoint.y - anchor.y) * scaleY
                    };
                }
                if (shape.endPoint) {
                    shape.endPoint = {
                        x: anchor.x + (shape.endPoint.x - anchor.x) * scaleX,
                        y: anchor.y + (shape.endPoint.y - anchor.y) * scaleY
                    };
                }
                if (Array.isArray(shape.waypoints)) {
                    shape.waypoints = shape.waypoints.map(p => ({
                        x: anchor.x + (p.x - anchor.x) * scaleX,
                        y: anchor.y + (p.y - anchor.y) * scaleY
                    }));
                }
                VexelSelectionGeometry.invalidateBounds(shape);
                return;
            }

            case 'boolean-result': {
                // Bounds come from the wrapped result path; scale that shape's
                // own geometry rather than the wrapper's cached rectangle.
                if (shape.result && typeof shape.result.getBounds === 'function') {
                    const resultBounds = shape.result.getBounds();
                    const resultTarget = {
                        x: anchor.x + (resultBounds.x - anchor.x) * scaleX,
                        y: anchor.y + (resultBounds.y - anchor.y) * scaleY,
                        width: resultBounds.width * scaleX,
                        height: resultBounds.height * scaleY,
                        scaleX,
                        scaleY,
                        anchor
                    };
                    VexelSelectionGeometry.applyBounds(
                        shape.result,
                        { bounds: resultBounds, state: { ...resultBounds } },
                        resultTarget
                    );
                }
                shape.x = target.x;
                shape.y = target.y;
                shape.width = target.width;
                shape.height = target.height;
                VexelSelectionGeometry.invalidateBounds(shape);
                return;
            }

            case 'text': {
                const baseFontSize = snapshot.state.fontSize !== undefined ? snapshot.state.fontSize : 16;
                shape.x = target.x;
                shape.y = target.y;
                shape.fontSize = baseFontSize * scaleY;
                VexelSelectionGeometry.invalidateBounds(shape);
                return;
            }

            default: {
                const baseScaleX = snapshot.state.scaleX || 1;
                const baseScaleY = snapshot.state.scaleY || 1;
                shape.x = target.x;
                shape.y = target.y;
                shape.width = target.width / baseScaleX;
                shape.height = target.height / baseScaleY;
                VexelSelectionGeometry.invalidateBounds(shape);
                return;
            }
        }
    }
}

if (typeof window !== 'undefined') {
    window.VexelSelectionGeometry = VexelSelectionGeometry;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = VexelSelectionGeometry;
}
