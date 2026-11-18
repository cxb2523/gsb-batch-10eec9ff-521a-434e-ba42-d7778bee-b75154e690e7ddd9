import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_VS_SHADER } from '../../src/defaults';
import { WebGLManager } from '../../src/offscreen-webgl/gl-manager';
import { WebGLManagerProxy } from '../../src/offscreen-webgl/proxy';

// Encodes the fragment's own resolution into the colour, so a frame rendered
// with a stale u_resolution is immediately visible as wrong pixels.
const gradient = `precision mediump float;
uniform vec2 u_resolution;
void main() { gl_FragColor = vec4(gl_FragCoord.x / u_resolution.x, gl_FragCoord.y / u_resolution.y, 0.0, 1.0); }`;

const solidRed = `precision mediump float;
void main() { gl_FragColor = vec4(1.0, 0.0, 0.0, 1.0); }`;

function pixel(canvas: HTMLCanvasElement, x: number, y: number): number[] {
	const copy = document.createElement('canvas');
	copy.width = canvas.width;
	copy.height = canvas.height;
	const context = copy.getContext('2d')!;
	context.drawImage(canvas, 0, 0);
	return Array.from(context.getImageData(x, y, 1, 1).data);
}

/** Expected colour for the gradient shader at canvas pixel (x, y) of a w×h canvas. */
function expectedGradient(w: number, h: number, x: number, y: number): number[] {
	// Canvas y = 0 is the top row, which is the last row in GL's bottom-up space.
	return [Math.round(((x + 0.5) / w) * 255), Math.round(((h - 1 - y + 0.5) / h) * 255), 0, 255];
}

function expectPixel(canvas: HTMLCanvasElement, x: number, y: number, expected: number[], tolerance = 3) {
	const actual = pixel(canvas, x, y);
	for (let channel = 0; channel < 4; channel++) {
		expect(
			Math.abs(actual[channel] - expected[channel]),
			`pixel (${x},${y}) channel ${channel}: got ${actual} expected ${expected}`
		).toBeLessThanOrEqual(tolerance);
	}
}

/**
 * A canvas transferred with `transferControlToOffscreen` propagates its new size
 * and committed frame back to the main-thread element asynchronously, so tests
 * poll instead of assuming a fixed delay.
 */
async function waitForSize(canvas: HTMLCanvasElement, width: number, height: number) {
	await vi.waitFor(() => expect([canvas.width, canvas.height]).toEqual([width, height]));
}

async function waitForPixel(canvas: HTMLCanvasElement, x: number, y: number, expected: number[], tolerance = 3) {
	await vi.waitFor(() => expectPixel(canvas, x, y, expected, tolerance));
}

const wait = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

async function createProxy(canvas: HTMLCanvasElement, width: number, height: number, fragment = gradient) {
	const proxy = new WebGLManagerProxy(canvas);
	await proxy.setVertexShaderAsync(DEFAULT_VS_SHADER);
	await proxy.setFragmentShadersAsync([fragment]);
	await proxy.setupWholeScreenQuadAsync();
	await proxy.resizeAsync(width, height);
	return proxy;
}

describe('shared context canvas sizes', () => {
	it('renders each differently-sized canvas with its own pixels', async () => {
		const sizes: [number, number][] = [
			[4, 4],
			[16, 2],
			[2, 16],
			[7, 5],
		];
		// Start each DOM canvas at a deliberately unrelated size so the shared
		// drawing buffer is never accidentally the right size for any instance.
		const canvases = sizes.map((_, index) => {
			const canvas = document.createElement('canvas');
			canvas.width = 1 + index * 13;
			canvas.height = 40 - index * 7;
			return canvas;
		});
		const proxies: WebGLManagerProxy[] = [];
		try {
			// Initialise in ascending order, painting older instances in between so
			// later instances grow/shrink the shared buffer around them.
			for (let index = 0; index < canvases.length; index++) {
				proxies[index] = await createProxy(canvases[index], sizes[index][0], sizes[index][1]);
				if (index > 0) {
					await proxies[0].paintCanvasAsync();
					await wait();
				}
			}

			for (let round = 0; round < 2; round++) {
				const order = round === 0 ? canvases.map((_, index) => index) : canvases.map((_, index) => canvases.length - 1 - index);
				for (const index of order) {
					await proxies[index].paintCanvasAsync();
					const [width, height] = sizes[index];
					await waitForSize(canvases[index], width, height);
					await waitForPixel(canvases[index], 0, 0, expectedGradient(width, height, 0, 0));
					await waitForPixel(canvases[index], width - 1, 0, expectedGradient(width, height, width - 1, 0));
					await waitForPixel(canvases[index], 0, height - 1, expectedGradient(width, height, 0, height - 1));
					await waitForPixel(canvases[index], width - 1, height - 1, expectedGradient(width, height, width - 1, height - 1));
				}
			}
		} finally {
			await Promise.all(proxies.map((proxy) => proxy.destroyAsync().catch(() => {})));
		}
	});

	it('keeps u_resolution and the drawing buffer in sync after resize', async () => {
		const canvas = document.createElement('canvas');
		canvas.width = 3;
		canvas.height = 3;
		const proxy = new WebGLManagerProxy(canvas);
		try {
			await proxy.setVertexShaderAsync(DEFAULT_VS_SHADER);
			await proxy.setFragmentShadersAsync([gradient]);
			await proxy.setupWholeScreenQuadAsync();
			// Deliberately never call updateUniform for u_resolution: resize itself
			// must establish the resolution the shader samples with.
			await proxy.resizeAsync(9, 4);
			await waitForSize(canvas, 9, 4);
			await waitForPixel(canvas, 0, 0, expectedGradient(9, 4, 0, 0));
			await waitForPixel(canvas, 8, 0, expectedGradient(9, 4, 8, 0));
			await waitForPixel(canvas, 0, 3, expectedGradient(9, 4, 0, 3));
			await waitForPixel(canvas, 8, 3, expectedGradient(9, 4, 8, 3));

			// A subsequent resize to a new size must present new-size content.
			await proxy.resizeAsync(3, 11);
			await waitForSize(canvas, 3, 11);
			await waitForPixel(canvas, 0, 0, expectedGradient(3, 11, 0, 0));
			await waitForPixel(canvas, 2, 10, expectedGradient(3, 11, 2, 10));

			// paintCanvas after resize still uses the new size.
			await proxy.paintCanvasAsync();
			await waitForPixel(canvas, 2, 10, expectedGradient(3, 11, 2, 10));
		} finally {
			await proxy.destroyAsync();
		}
	});

	it('resizing one instance leaves the other instance size and pixels untouched', async () => {
		const small = document.createElement('canvas');
		const large = document.createElement('canvas');
		small.width = 5;
		small.height = 5;
		large.width = 5;
		large.height = 5;
		const smallProxy = await createProxy(small, 5, 5);
		const largeProxy = await createProxy(large, 12, 9);
		try {
			await smallProxy.paintCanvasAsync();
			await largeProxy.paintCanvasAsync();
			await waitForSize(large, 12, 9);
			await waitForPixel(large, 11, 8, expectedGradient(12, 9, 11, 8));
			const largeBefore = [pixel(large, 0, 0), pixel(large, 11, 0), pixel(large, 0, 8), pixel(large, 11, 8)];

			// Grow the small instance well past the large one, then shrink it again.
			await smallProxy.resizeAsync(24, 17);
			await waitForSize(small, 24, 17);
			await waitForPixel(small, 23, 16, expectedGradient(24, 17, 23, 16));
			expect([large.width, large.height]).toEqual([12, 9]);
			expect([pixel(large, 0, 0), pixel(large, 11, 0), pixel(large, 0, 8), pixel(large, 11, 8)]).toEqual(largeBefore);

			await smallProxy.resizeAsync(2, 3);
			await waitForSize(small, 2, 3);
			await waitForPixel(small, 0, 0, expectedGradient(2, 3, 0, 0));
			await waitForPixel(small, 1, 2, expectedGradient(2, 3, 1, 2));

			// The large instance repaints correctly after the small one shrank the
			// requested size but not the shared buffer.
			await largeProxy.paintCanvasAsync();
			await waitForSize(large, 12, 9);
			await waitForPixel(large, 0, 0, expectedGradient(12, 9, 0, 0));
			await waitForPixel(large, 11, 8, expectedGradient(12, 9, 11, 8));
		} finally {
			await smallProxy.destroyAsync().catch(() => {});
			await largeProxy.destroyAsync().catch(() => {});
		}
	});

	it('still repaints after a sibling sharing the context is destroyed', async () => {
		const first = document.createElement('canvas');
		const second = document.createElement('canvas');
		first.width = 9;
		first.height = 7;
		second.width = 4;
		second.height = 6;
		const firstProxy = await createProxy(first, 9, 7);
		const secondProxy = await createProxy(second, 4, 6);
		try {
			await firstProxy.paintCanvasAsync();
			await secondProxy.paintCanvasAsync();
			await waitForPixel(second, 3, 5, expectedGradient(4, 6, 3, 5));

			await firstProxy.destroyAsync();
			await wait(20);

			await secondProxy.paintCanvasAsync();
			await waitForSize(second, 4, 6);
			await waitForPixel(second, 0, 0, expectedGradient(4, 6, 0, 0));
			await waitForPixel(second, 3, 5, expectedGradient(4, 6, 3, 5));

			// A freshly created instance after both orderings still renders at its size.
			const third = document.createElement('canvas');
			const thirdProxy = await createProxy(third, 6, 2, solidRed);
			try {
				await thirdProxy.paintCanvasAsync();
				await waitForSize(third, 6, 2);
				await waitForPixel(third, 0, 0, [255, 0, 0, 255], 0);
				await waitForPixel(third, 5, 1, [255, 0, 0, 255], 0);
			} finally {
				await thirdProxy.destroyAsync().catch(() => {});
			}
		} finally {
			await firstProxy.destroyAsync().catch(() => {});
			await secondProxy.destroyAsync().catch(() => {});
		}
	});

	it('rejects invalid sizes through the proxy instead of silently rendering', async () => {
		const canvas = document.createElement('canvas');
		canvas.width = 5;
		canvas.height = 5;
		const proxy = await createProxy(canvas, 5, 5);
		try {
			await expect(proxy.resizeAsync(0, 4)).rejects.toThrow(/Invalid canvas size/);
			await expect(proxy.resizeAsync(4, -2)).rejects.toThrow(/Invalid canvas size/);
			await expect(proxy.resizeAsync(Number.NaN, 4)).rejects.toThrow(/Invalid canvas size/);
			await expect(proxy.resizeAsync(Number.POSITIVE_INFINITY, 4)).rejects.toThrow(/Invalid canvas size/);

			// The instance remains usable at its previous size after rejected resizes.
			await proxy.resizeAsync(6, 3);
			await waitForSize(canvas, 6, 3);
			await waitForPixel(canvas, 0, 0, expectedGradient(6, 3, 0, 0));
		} finally {
			await proxy.destroyAsync();
		}
	});

	it('returns an error Result from the manager for invalid sizes', () => {
		const canvas = document.createElement('canvas');
		canvas.width = 4;
		canvas.height = 4;
		const result = WebGLManager.fromHTMLCanvasElement(canvas);
		expect(result.error).toBeNull();
		const manager = result.data!;
		try {
			expect(manager.setVertexShader(DEFAULT_VS_SHADER).error).toBeNull();
			expect(manager.setFragmentShaders([gradient]).error).toBeNull();
			expect(manager.setupWholeScreenQuad().error).toBeNull();

			const invalid = manager.resize(0, 0);
			expect(invalid.error).not.toBeNull();
			expect(invalid.error?.message).toMatch(/Invalid canvas size/);

			// A failed resize must not corrupt the instance: a valid resize still works.
			expect(manager.resize(3, 6).error).toBeNull();
			const gl = manager.getGLContext();
			const buffer = new Uint8Array(4);
			gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buffer);
			// Bottom-left pixel of a 3×6 gradient: uv = (0.5/3, 0.5/6) → ~[42, 21, 0, 255].
			expect(Math.abs(buffer[0] - 42)).toBeLessThanOrEqual(3);
			expect(Math.abs(buffer[1] - 21)).toBeLessThanOrEqual(3);
			expect(buffer[2]).toBe(0);
			expect(buffer[3]).toBe(255);
		} finally {
			manager.destroy();
		}
	});
});
