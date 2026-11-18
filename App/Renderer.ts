import AccessPoint from "./AccessPoint";
import { Mode } from "./Mode";
import Reading from "./Reading";
import RenderFactory from "./RenderFactory";
import Triangulation from "./Triangulation";

export default class Renderer {
	private readonly canvas: HTMLCanvasElement;
	private readonly gl: WebGL2RenderingContext;
	private readonly shader_program: WebGLProgram;

	constructor(canvas: HTMLCanvasElement) {
		this.canvas = canvas;
		this.gl = RenderFactory.getContext(this.canvas);
		this.shader_program = RenderFactory.getShaderProgram(this.gl);
	}

	render(mode: Mode, readings: Reading[], access_point: AccessPoint | null): void {
		// fewer than three readings cannot form a triangle; clear out any stale heat map
		if (readings.length < 3) {
			this.clear();
			return;
		}

		const triangulation = new Triangulation(mode, readings, access_point);
		if (triangulation.vertex_coordinates.length === 0 || triangulation.vertex_coordinates.length % 6 !== 0
			|| triangulation.vertex_color_parts.length === 0 || triangulation.vertex_color_parts.length % 12 !== 0) {
			this.clear();
			return;
		}

		// clear first so a previous heat map never shows through the new, partially-transparent triangles
		this.clear();
		this.setOffset();
		this.setCoords(triangulation);
		this.setColors(triangulation);
		this.gl.drawArrays(this.gl.TRIANGLES, 0, triangulation.vertex_coordinates.length / 2);
	}

	resize(width: number, height: number): void {
		this.canvas.width = width;
		this.canvas.height = height;

		this.setOffset();
	}

	clear(): void {
		this.gl.clear(this.gl.COLOR_BUFFER_BIT | this.gl.DEPTH_BUFFER_BIT);
	}

	private setOffset(): void {
		// the pixel size is kept in sync with the displayed size by resize(); fall back to the displayed size
		// when the canvas has not been sized yet
		const width = this.canvas.width || this.canvas.clientWidth;
		const height = this.canvas.height || this.canvas.clientHeight;

		const offset_uniform = this.gl.getUniformLocation(this.shader_program, "u_offset");
		this.gl.uniform2f(offset_uniform, width, height);
	}

	private setCoords(triangulation: Triangulation): void {
		this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.gl.createBuffer());
		this.gl.bufferData(this.gl.ARRAY_BUFFER, new Uint16Array(triangulation.vertex_coordinates), this.gl.STREAM_DRAW);

		const coords_attribute = this.gl.getAttribLocation(this.shader_program, "a_coords");
		this.gl.vertexAttribPointer(coords_attribute, 2, this.gl.UNSIGNED_SHORT, false, 0, 0);
		this.gl.enableVertexAttribArray(coords_attribute);
	}

	private setColors(triangulation: Triangulation): void {
		this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.gl.createBuffer());
		this.gl.bufferData(this.gl.ARRAY_BUFFER, new Uint8Array(triangulation.vertex_color_parts), this.gl.STREAM_DRAW);

		const color_attribute = this.gl.getAttribLocation(this.shader_program, "a_color");
		this.gl.vertexAttribPointer(color_attribute, 4, this.gl.UNSIGNED_BYTE, false, 0, 0);
		this.gl.enableVertexAttribArray(color_attribute);
	}
}
