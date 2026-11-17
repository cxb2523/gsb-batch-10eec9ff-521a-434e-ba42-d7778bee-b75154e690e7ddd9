/**
 * Picking part labels must match painting them.
 *
 * The independent reference here is the painter's own contract: a label is
 * rasterized at `labelPixels(scale)` with the given align/baseline anchor, and
 * `partLabels` is the single source of where the anchor is. The picker is
 * tested against that geometry, not against another copy of it, so these
 * cases fail the way the reported bugs did — hit box and drawn text drifting
 * apart under zoom, rotation and drag.
 *
 * A deterministic measurer stands in for the browser's `measureText`: it
 * returns a width the test can reason about exactly, while exercising the same
 * "measured width, not a per-character guess" code path the app uses.
 */

import { describe, expect, it } from 'vitest';
import type { Rect, Vec2 } from '$lib/canvas';
import {
	FALLBACK_CHAR_ADVANCE,
	LABEL_MIN_PIXELS,
	LABEL_VISIBLE_SCALE,
	labelAt,
	labelPixels,
	labelScreenBox,
	measureLabelText,
	partLabelFont,
	partLabels,
	type PartLabel,
	type TextMeasurer
} from '$lib/schematic/draw';
import { defaultParams, type Instance, type Rotation, type Schematic } from '$lib/schematic/model';

/** A linear identity world->screen transform: world units are screen pixels. */
function identityScreen(world: Vec2): Vec2 {
	return { x: world.x, y: world.y };
}

function part(over: Partial<Instance> = {}): Instance {
	return {
		id: over.id ?? 'r1',
		kind: 'resistor',
		name: over.name ?? 'R1',
		x: over.x ?? 100,
		y: over.y ?? 100,
		rotation: over.rotation ?? 0,
		params: { ...defaultParams('resistor'), ...(over.params ?? {}) },
		labels: over.labels
	};
}

function schematic(...instances: Instance[]): Schematic {
	return { instances, wires: [] };
}

/**
 * One screen pixel per advance unit, independent of point size: lets a test
 * assert exact geometry rather than whatever the platform font returns.
 */
const stubMeasure: TextMeasurer = (text) => text.length;

const centre = (box: Rect): Vec2 => ({ x: box.x + box.w / 2, y: box.y + box.h / 2 });
const inside = (point: Vec2, box: Rect): boolean =>
	point.x >= box.x && point.x <= box.x + box.w && point.y >= box.y && point.y <= box.y + box.h;

describe('labelPixels / partLabelFont', () => {
	it('grows with the zoom until the screen-pixel cap, then stays put', () => {
		expect(labelPixels(1)).toBeCloseTo(11);
		expect(labelPixels(2)).toBeCloseTo(15);
		// 11 * 4 = 44 world-derived pixels, but the cap is 15 screen pixels.
		expect(labelPixels(4)).toBe(15);
		expect(partLabelFont(4)).toBe(15);
	});

	it('reports no rendered font at or below the draw threshold', () => {
		expect(partLabelFont(LABEL_VISIBLE_SCALE)).toBeNull();
		expect(partLabelFont(LABEL_VISIBLE_SCALE / 2)).toBeNull();
		// Between the threshold and the painter's minimum size nothing renders
		// either: 11 * scale has to reach 6 px before the painter keeps the text.
		expect(partLabelFont(0.4)).toBeNull();
		expect(partLabelFont(0.55)).not.toBeNull();
	});

	it('falls back to the monospace estimate without a canvas, still finite', () => {
		// Node has no document; the module must degrade rather than throw.
		const width = measureLabelText('R1', 11);
		expect(width).toBeCloseTo(2 * 11 * FALLBACK_CHAR_ADVANCE);
		expect(width).toBeGreaterThan(0);
	});

	it('keeps the rendered size at or above the painter minimum while labels show', () => {
		// Smallest scale at which 11 * scale clears the 6 px painter minimum.
		const smallestShown = partLabelFont(LABEL_MIN_PIXELS / 11 + 1e-9);
		expect(smallestShown).not.toBeNull();
		expect(smallestShown as number).toBeGreaterThanOrEqual(LABEL_MIN_PIXELS);
	});
});

describe('labelScreenBox anchors', () => {
	const toScreen = identityScreen;

	it('centres a center/bottom label on its anchor and grows upward', () => {
		const label: PartLabel = {
			slot: 'name',
			text: 'R1',
			at: { x: 50, y: 60 },
			align: 'center',
			baseline: 'bottom',
			strong: true
		};
		const box = labelScreenBox(label, toScreen, 1, stubMeasure);
		// Width is the measured advance (2 units for a two-character label), not
		// length * size * 0.6.
		expect(box.w).toBe(2);
		expect(box.x).toBeCloseTo(50 - 1);
		// Bottom edge sits exactly on the anchor; the box extends one font size up.
		expect(box.y + box.h).toBeCloseTo(60);
		expect(box.h).toBe(labelPixels(1));
	});

	it('grows right and down from a left/top anchor', () => {
		const label: PartLabel = {
			slot: 'value',
			text: '1k',
			at: { x: 50, y: 60 },
			align: 'left',
			baseline: 'top',
			strong: false
		};
		const box = labelScreenBox(label, toScreen, 1, stubMeasure);
		expect(box.x).toBe(50);
		expect(box.y).toBe(60);
		expect(box.w).toBe(2);
		expect(box.h).toBe(labelPixels(1));
	});

	it('uses the capped screen size past the cap so the box stops growing', () => {
		const label: PartLabel = {
			slot: 'name',
			text: 'R1',
			at: { x: 0, y: 0 },
			align: 'left',
			baseline: 'top',
			strong: true
		};
		const atOne = labelScreenBox(label, toScreen, 1, stubMeasure);
		const atFour = labelScreenBox(label, toScreen, 4, stubMeasure);
		expect(atFour.h).toBe(15);
		expect(atFour.h).toBeLessThan(4 * atOne.h);
		// The measured width is taken at the same capped size the painter uses.
		expect(atFour.w).toBe(stubMeasure(label.text, 15));
	});
});

describe('labelAt picking', () => {
	it('picks the label at its centre under the default zoom', () => {
		const instance = part();
		const [name] = partLabels(instance);
		const box = labelScreenBox(name, identityScreen, 1, stubMeasure);
		const hit = labelAt(schematic(instance), centre(box), identityScreen, 1, stubMeasure);
		expect(hit?.instance.id).toBe('r1');
		expect(hit?.label.slot).toBe('name');
	});

	it('keeps a point just outside the measured box a miss', () => {
		const instance = part();
		const [name] = partLabels(instance);
		const box = labelScreenBox(name, identityScreen, 1, stubMeasure);
		// Three pixels clear: beyond the 2 px picking slack, on blank canvas.
		const miss: Vec2 = { x: box.x + box.w + 3, y: box.y + box.h / 2 };
		expect(labelAt(schematic(instance), miss, identityScreen, 1, stubMeasure)).toBeNull();
	});

	it('does not exceed the measured text width when zoomed near the cap', () => {
		const instance = part();
		const scale = 4; // labelPixels is already pinned at 15
		const [name] = partLabels(instance);
		const box = labelScreenBox(name, identityScreen, scale, stubMeasure);
		const measured = stubMeasure(name.text, labelPixels(scale));
		expect(box.w).toBe(measured);
		// A point past the measured advance, inside what the old length*0.6*size
		// guess could have claimed, must not grab the label.
		const beyond: Vec2 = { x: box.x + measured + 4, y: box.y + box.h / 2 };
		expect(labelAt(schematic(instance), beyond, identityScreen, scale, stubMeasure)).toBeNull();
	});

	it('picks a 90°-rotated part label where it is drawn, not where it used to be', () => {
		const upright = part({ rotation: 0 });
		const turned = part({ id: 'r2', rotation: 90 as Rotation });
		const [turnedName] = partLabels(turned);
		const [uprightName] = partLabels(upright);
		const drawnBox = labelScreenBox(turnedName, identityScreen, 1, stubMeasure);

		// Drawn position after rotation is a hit.
		const drawn = labelAt(
			schematic(turned),
			centre(drawnBox),
			identityScreen,
			1,
			stubMeasure
		);
		expect(drawn?.instance.id).toBe('r2');

		// Rotation actually moved the anchor; otherwise this test proves nothing.
		expect(turnedName.at).not.toEqual(uprightName.at);

		// The unrotated anchor is blank space for the rotated part.
		const oldSpot: Vec2 = { x: uprightName.at.x, y: uprightName.at.y };
		expect(inside(oldSpot, drawnBox)).toBe(false);
		expect(labelAt(schematic(turned), oldSpot, identityScreen, 1, stubMeasure)).toBeNull();
	});

	it('picks nothing once labels are below the draw threshold', () => {
		const instance = part();
		const [name] = partLabels(instance);
		const box = labelScreenBox(name, identityScreen, 1, stubMeasure);
		const scale = LABEL_VISIBLE_SCALE / 2;
		// Clicking the screen position the label occupies when shown: nothing is
		// drawn there now, so nothing is picked.
		expect(labelAt(schematic(instance), centre(box), identityScreen, scale, stubMeasure)).toBeNull();
	});

	it('follows a dragged label to its offset position and vacates the old one', () => {
		const offset = { x: 40, y: 25 };
		const moved = part({ labels: { name: offset } });
		const plain = part({ id: 'r0' });
		const [movedName] = partLabels(moved);
		const [plainName] = partLabels(plain);

		// partLabels is the shared placement result: it carries the drag offset.
		expect(movedName.at).toEqual({ x: plainName.at.x + offset.x, y: plainName.at.y + offset.y });

		const box = labelScreenBox(movedName, identityScreen, 1, stubMeasure);
		const hit = labelAt(schematic(moved), centre(box), identityScreen, 1, stubMeasure);
		expect(hit?.label.slot).toBe('name');
		expect(hit?.instance.id).toBe('r1');

		// The pre-drag position no longer answers.
		const oldBox = labelScreenBox(plainName, identityScreen, 1, stubMeasure);
		expect(inside(centre(oldBox), box)).toBe(false);
		expect(
			labelAt(schematic(moved), centre(oldBox), identityScreen, 1, stubMeasure)
		).toBeNull();
	});

	it('returns the topmost label when two overlap, in back-to-front order', () => {
		const back = part({ id: 'back', name: 'R1' });
		const front = part({ id: 'front', name: 'R2' });
		// Same anchor for both names: the boxes coincide.
		const [backName] = partLabels(back);
		const point = centre(labelScreenBox(backName, identityScreen, 1, stubMeasure));
		const hit = labelAt(schematic(back, front), point, identityScreen, 1, stubMeasure);
		expect(hit?.instance.id).toBe('front');
	});

	it('honours a pan/zoom transform between world anchors and screen hits', () => {
		const instance = part({ x: 0, y: 0 });
		const scale = 2;
		const pan = { x: 30, y: -40 };
		const toScreen = (world: Vec2): Vec2 => ({
			x: world.x * scale + pan.x,
			y: world.y * scale + pan.y
		});
		const [name] = partLabels(instance);
		const box = labelScreenBox(name, toScreen, scale, stubMeasure);
		const hit = labelAt(schematic(instance), centre(box), toScreen, scale, stubMeasure);
		expect(hit?.label.slot).toBe('name');
		// The capped-not-yet size at scale 2 is 15 screen pixels.
		expect(box.h).toBe(15);
	});
});
