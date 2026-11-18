import Mockito from "ts-mockito";
import { Test, TestSuite } from "xunit.ts";

import AccessPoint from "../App/AccessPoint";
import AppViewModel from "../App/AppViewModel";
import { Mode } from "../App/Mode";
import Point from "../App/Point";
import Reading from "../App/Reading";
import Renderer from "../App/Renderer";
import Signal from "../App/Signal";
import Triangulation from "../App/Triangulation";
import { any } from "./MockHelpers";

export default class RenderRefreshTests extends TestSuite {
	private static readings(): Reading[] {
		return [
			new Reading(1, new Point(10, 10), [new Signal("mac1", "ssid1", 2, 1, -40)]),
			new Reading(2, new Point(20, 30), [new Signal("mac1", "ssid1", 2, 1, -60)]),
			new Reading(3, new Point(40, 20), [new Signal("mac1", "ssid1", 2, 1, -80)])
		];
	}

	private static renderer(): { renderer: Renderer, gl_mock: WebGL2RenderingContext, canvas: HTMLCanvasElement } {
		const gl_mock = Mockito.mock<WebGL2RenderingContext>();
		const shader = Mockito.mock<WebGLShader>();
		const program = Mockito.mock<WebGLProgram>();
		Mockito.when(gl_mock.createShader(any())).thenReturn(Mockito.instance(shader));
		Mockito.when(gl_mock.createProgram()).thenReturn(Mockito.instance(program));

		const canvas_mock = Mockito.mock<HTMLCanvasElement>();
		Mockito.when(canvas_mock.getContext("webgl2")).thenReturn(Mockito.instance(gl_mock));

		const canvas = Mockito.instance(canvas_mock);
		return { renderer: new Renderer(canvas), gl_mock: gl_mock, canvas: canvas };
	}

	@Test()
	rendersWithNewAccessPointWhenSelectionChanges() {
		//arrange
		const state = new AppViewModel();
		const renderer = Mockito.mock<Renderer>();
		state.renderer = Mockito.instance(renderer);
		state.readings = RenderRefreshTests.readings();

		const access_point = new AccessPoint("ssid1", 2, "mac1");

		//act
		state.selected = access_point;

		//assert
		Mockito.verify(renderer.render(state.mode, state.readings, access_point)).once();
	}

	@Test()
	rendersWithNewModeWhenModeChanges() {
		//arrange
		const state = new AppViewModel();
		const renderer = Mockito.mock<Renderer>();
		state.renderer = Mockito.instance(renderer);
		state.readings = RenderRefreshTests.readings();
		const access_point = new AccessPoint("ssid1", 2, "mac1");
		state.selected = access_point;

		//act
		state.mode = Mode.SNR;

		//assert
		Mockito.verify(renderer.render(Mode.SNR, state.readings, access_point)).once();
	}

	@Test()
	rerendersUsingTheLatestReadingsAfterDeletion() {
		//arrange
		const state = new AppViewModel();
		const renderer = Mockito.mock<Renderer>();
		state.renderer = Mockito.instance(renderer);
		state.readings = RenderRefreshTests.readings().concat(
			new Reading(4, new Point(50, 40), [])
		);

		let rendered: Reading[] = [];
		Mockito.when(renderer.render(any(), any(), any()))
			.thenCall((_mode: Mode, readings: Reading[]) => { rendered = readings.slice(); });

		//act
		state.deleteDataPoint(3);
		state.selected = new AccessPoint("ssid1");

		//assert
		this.assert.count(3, state.readings);
		this.assert.count(3, rendered);
		this.assert.equal(false, rendered.some(reading => reading.id === 4));
	}

	@Test()
	rendersWithCurrentStateWhenSwitchingBackToASignal() {
		//arrange
		const state = new AppViewModel();
		const renderer = Mockito.mock<Renderer>();
		state.renderer = Mockito.instance(renderer);
		state.readings = RenderRefreshTests.readings();
		state.mode = Mode.SNR;
		state.selected = new AccessPoint("ssid1");

		//act
		state.mode = Mode.Signal;

		//assert
		Mockito.verify(renderer.render(Mode.Signal, state.readings, any())).once();
	}

	@Test()
	clearsCanvasWhenSwitchingAccessPointWithTooFewReadings() {
		//arrange
		const { renderer, gl_mock } = RenderRefreshTests.renderer();

		const state = new AppViewModel();
		state.renderer = renderer;
		state.readings = RenderRefreshTests.readings().slice(0, 2);

		//act
		state.selected = new AccessPoint("ssid1", 2, "mac1");

		//assert
		Mockito.verify(gl_mock.clear(any())).atLeast(1);
		Mockito.verify(gl_mock.drawArrays(any(), any(), any())).never();
	}

	@Test()
	clearsCanvasWhenSwitchingModeWithTooFewReadings() {
		//arrange
		const { renderer, gl_mock } = RenderRefreshTests.renderer();

		const state = new AppViewModel();
		state.renderer = renderer;
		state.readings = RenderRefreshTests.readings().slice(0, 1);
		state.selected = new AccessPoint("ssid1", 2, "mac1");

		//act
		state.mode = Mode.SNR;

		//assert
		Mockito.verify(gl_mock.clear(any())).atLeast(1);
		Mockito.verify(gl_mock.drawArrays(any(), any(), any())).never();
	}

	@Test()
	clearsCanvasWhenAllReadingsAreDeleted() {
		//arrange
		const { renderer, gl_mock } = RenderRefreshTests.renderer();

		const state = new AppViewModel();
		state.renderer = renderer;
		state.readings = RenderRefreshTests.readings();

		//act
		state.clearAllDataPoints();

		//assert
		this.assert.empty(state.readings);
		Mockito.verify(gl_mock.clear(any())).atLeast(1);
		Mockito.verify(gl_mock.drawArrays(any(), any(), any())).never();
	}

	@Test()
	emptyReadingsDoNotThrow() {
		//arrange
		const access_point = new AccessPoint("ssid1");
		const { renderer } = RenderRefreshTests.renderer();

		//act + assert
		this.assert.doesNotThrow(() => new Triangulation(Mode.Signal, [], access_point));
		this.assert.doesNotThrow(() => new Triangulation(Mode.SNR, [], access_point));
		this.assert.doesNotThrow(() => renderer.render(Mode.Signal, [], access_point));
	}

	@Test()
	singleAndDoubleReadingsDoNotThrow() {
		//arrange
		const access_point = new AccessPoint("ssid1", 2, "mac1");
		const readings = RenderRefreshTests.readings();
		const { renderer } = RenderRefreshTests.renderer();

		//act + assert
		this.assert.doesNotThrow(() => new Triangulation(Mode.Signal, readings.slice(0, 1), access_point));
		this.assert.doesNotThrow(() => new Triangulation(Mode.SNR, readings.slice(0, 2), access_point));
		this.assert.doesNotThrow(() => renderer.render(Mode.Signal, readings.slice(0, 1), access_point));
		this.assert.doesNotThrow(() => renderer.render(Mode.SNR, readings.slice(0, 2), access_point));
	}

	@Test()
	triangulationIsEmptyWhenFewerThanThreeReadings() {
		//arrange
		const access_point = new AccessPoint("ssid1");
		const readings = RenderRefreshTests.readings();

		//act
		const empty = new Triangulation(Mode.Signal, [], access_point);
		const single = new Triangulation(Mode.Signal, readings.slice(0, 1), access_point);
		const double = new Triangulation(Mode.Signal, readings.slice(0, 2), access_point);

		//assert
		this.assert.empty(empty.vertex_coordinates);
		this.assert.empty(empty.vertex_color_parts);
		this.assert.empty(single.vertex_coordinates);
		this.assert.empty(single.vertex_color_parts);
		this.assert.empty(double.vertex_coordinates);
		this.assert.empty(double.vertex_color_parts);
	}

	@Test()
	resizeUpdatesCanvasSizeAndShaderOffset() {
		//arrange
		const { renderer, gl_mock, canvas } = RenderRefreshTests.renderer();

		//act
		renderer.resize(1024, 768);

		//assert
		this.assert.equal(1024, canvas.width);
		this.assert.equal(768, canvas.height);
		Mockito.verify(gl_mock.uniform2f(any(), 1024, 768)).atLeast(1);
	}

	@Test()
	resizeRefreshesViewWithNewOffset() {
		//arrange
		const state = new AppViewModel();
		const renderer = Mockito.mock<Renderer>();
		state.renderer = Mockito.instance(renderer);
		state.readings = RenderRefreshTests.readings();

		//act
		state.resize(800, 600);

		//assert
		Mockito.verify(renderer.resize(800, 600)).once();
		Mockito.verify(renderer.render(any(), any(), any())).atLeast(1);
	}

	@Test()
	rendererRendersAfterResizeWithUpdatedOffset() {
		//arrange
		const { renderer, gl_mock } = RenderRefreshTests.renderer();
		const access_point = new AccessPoint("ssid1", 2, "mac1");
		const readings = RenderRefreshTests.readings();

		//act
		renderer.resize(640, 480);
		renderer.render(Mode.Signal, readings, access_point);

		//assert
		Mockito.verify(gl_mock.uniform2f(any(), 640, 480)).atLeast(1);
		Mockito.verify(gl_mock.drawArrays(any(), any(), 3)).atLeast(1);
	}

	@Test()
	keepsSignalAndSnrColorRules() {
		//arrange
		const readings = RenderRefreshTests.readings();
		const access_point = new AccessPoint("ssid1", 2, "mac1");

		//act
		const signals = new Triangulation(Mode.Signal, readings, access_point);
		const snr = new Triangulation(Mode.SNR, readings, access_point);

		//assert
		const expected_signals = [
			255, 255, 0, 191,
			255, 0, 0, 191,
			0, 255, 0, 191
		];
		this.assert.equal(expected_signals, signals.vertex_color_parts);

		const expected_snr = [
			85, 255, 0, 191,
			255, 255, 0, 191,
			0, 191, 0, 191
		];
		this.assert.equal(expected_snr, snr.vertex_color_parts);
	}

	@Test()
	usesUnmatchedColorsForAnUnknownAccessPoint() {
		//arrange
		const readings = RenderRefreshTests.readings();
		const other = new AccessPoint("ssid2", 2, "mac2");

		//act
		const triangulation = new Triangulation(Mode.Signal, readings, other);

		//assert
		const expected = [
			0, 0, 0, 95,
			0, 0, 0, 95,
			0, 0, 0, 95
		];
		this.assert.equal(expected, triangulation.vertex_color_parts);
	}
}
