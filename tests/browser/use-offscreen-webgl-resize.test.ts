import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { OffscreenWebGL } from '../../src/offscreen-webgl/offscreen-webgl';

// The hook owns u_resolution, so this shader reveals the resolution the last
// frame was rendered with: a stale uniform produces visibly wrong pixels.
const RESOLUTION_GRADIENT = `precision highp float;
uniform vec2 u_resolution;
void main() {
	vec2 uv = gl_FragCoord.xy / u_resolution;
	gl_FragColor = vec4(uv.x, uv.y, 0.0, 1.0);
}`;

function pixel(canvas: HTMLCanvasElement, x: number, y: number): number[] {
	const copy = document.createElement('canvas');
	copy.width = canvas.width;
	copy.height = canvas.height;
	const context = copy.getContext('2d')!;
	context.drawImage(canvas, 0, 0);
	return Array.from(context.getImageData(x, y, 1, 1).data);
}

function expectedGradient(w: number, h: number, x: number, y: number): number[] {
	// Canvas y = 0 is the top row, the last row in GL's bottom-up space.
	return [Math.round(((x + 0.5) / w) * 255), Math.round(((h - 1 - y + 0.5) / h) * 255), 0, 255];
}

async function expectCanvasMatchesResolution(canvas: HTMLCanvasElement) {
	const w = canvas.width;
	const h = canvas.height;
	const corners: [number, number][] = [
		[0, 0],
		[w - 1, 0],
		[0, h - 1],
		[w - 1, h - 1],
	];
	for (const [x, y] of corners) {
		const expected = expectedGradient(w, h, x, y);
		await vi.waitFor(() => {
			const actual = pixel(canvas, x, y);
			for (let channel = 0; channel < 4; channel++) {
				expect(
					Math.abs(actual[channel] - expected[channel]),
					`${w}x${h} pixel (${x},${y}) channel ${channel}: got ${actual} expected ${expected}`
				).toBeLessThanOrEqual(4);
			}
		});
	}
}

describe('useOffscreenWebGL size chain', () => {
	it('keeps u_resolution consistent with each component canvas size', async () => {
		const container = document.createElement('div');
		document.body.appendChild(container);
		const root = createRoot(container);
		const sizeA = { width: 48, height: 24 };
		const sizeB = { width: 20, height: 64 };
		try {
			root.render(
				createElement(
					'div',
					null,
					createElement(
						'div',
						{ style: { width: `${sizeA.width}px`, height: `${sizeA.height}px` } },
						createElement(OffscreenWebGL, { fragmentShader: RESOLUTION_GRADIENT })
					),
					createElement(
						'div',
						{ style: { width: `${sizeB.width}px`, height: `${sizeB.height}px` } },
						createElement(OffscreenWebGL, { fragmentShader: RESOLUTION_GRADIENT })
					)
				)
			);

			await vi.waitFor(() => {
				const canvases = container.querySelectorAll('canvas');
				expect(canvases.length).toBe(2);
				for (const canvas of canvases) expect(canvas.dataset.ready).toBe('true');
			});
			const [canvasA, canvasB] = Array.from(container.querySelectorAll('canvas'));
			await expectCanvasMatchesResolution(canvasA);
			await expectCanvasMatchesResolution(canvasB);

			// Resize the first component: u_resolution must follow the canvas size.
			(canvasA.parentElement as HTMLElement).style.width = '72px';
			(canvasA.parentElement as HTMLElement).style.height = '40px';
			const expectedWidth = Math.round(72 * window.devicePixelRatio);
			const expectedHeight = Math.round(40 * window.devicePixelRatio);
			await vi.waitFor(() => expect([canvasA.width, canvasA.height]).toEqual([expectedWidth, expectedHeight]));
			await expectCanvasMatchesResolution(canvasA);

			// The sibling is unaffected by the other component's resize.
			const siblingWidth = Math.round(sizeB.width * window.devicePixelRatio);
			const siblingHeight = Math.round(sizeB.height * window.devicePixelRatio);
			expect([canvasB.width, canvasB.height]).toEqual([siblingWidth, siblingHeight]);
			await expectCanvasMatchesResolution(canvasB);
		} finally {
			root.unmount();
			container.remove();
		}
	});

	it('exposes a failed resize through data-error instead of keeping a stale frame', async () => {
		const RealResizeObserver = globalThis.ResizeObserver;
		let trigger: ResizeObserverCallback | null = null;
		class FakeResizeObserver {
			constructor(callback: ResizeObserverCallback) {
				trigger = callback;
			}
			observe() {}
			unobserve() {}
			disconnect() {
				trigger = null;
			}
		}
		// @ts-expect-error test double
		globalThis.ResizeObserver = FakeResizeObserver;

		const container = document.createElement('div');
		document.body.appendChild(container);
		const root = createRoot(container);
		try {
			root.render(
				createElement(
					'div',
					{ style: { width: '32px', height: '16px' } },
					createElement(OffscreenWebGL, { fragmentShader: RESOLUTION_GRADIENT })
				)
			);
			const canvas = await vi.waitFor(() => {
				const canvas = container.querySelector('canvas')!;
				expect(canvas.dataset.ready).toBe('true');
				return canvas;
			});
			expect(canvas.dataset.error).toBe('false');
			expect(trigger).not.toBeNull();

			// Report an unusable size: the resize must fail and surface the error.
			(trigger as unknown as ResizeObserverCallback)(
				[{ contentRect: { width: Infinity, height: 16 } } as unknown as ResizeObserverEntry],
				{} as ResizeObserver
			);
			await vi.waitFor(() => expect(canvas.dataset.error).toBe('true'));
			expect(canvas.dataset.ready).toBe('false');
		} finally {
			root.unmount();
			container.remove();
			globalThis.ResizeObserver = RealResizeObserver;
		}
	});
});
