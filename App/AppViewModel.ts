import AccessPoint from "./AccessPoint";
import AccessPointGrouping from "./AccessPointGrouping";
import BackgroundParser from "./BackgroundParser";
import { Mode } from "./Mode";
import Point from "./Point";
import Reading from "./Reading";
import Renderer from "./Renderer";
import Signal from "./Signal";
import SignalService from "./SignalService";

export default class AppViewModel {
	name: string = "";
	background: string = "";
	pixelated: boolean = true;
	readings: Reading[] = [];
	current: Reading = new Reading(0, new Point(0, 0), []);
	group_by: AccessPointGrouping = new AccessPointGrouping();
	debug: boolean = false;

	/** changing the mode re-renders the heat map using the current readings */
	declare mode: Mode;

	/** changing the access point re-renders the heat map using the current readings */
	declare selected: AccessPoint | null;

	background_parser: BackgroundParser | null = null;
	signal_service: SignalService | null = null;
	renderer: Renderer | null = null;

	constructor() {
		let mode = Mode.Signal;
		let selected: AccessPoint | null = null;

		Object.defineProperty(this, "mode", {
			enumerable: true,
			configurable: true,
			get: () => mode,
			set: (value: Mode) => {
				if (mode === value)
					return;

				mode = value;
				this.refresh();
			}
		});

		Object.defineProperty(this, "selected", {
			enumerable: true,
			configurable: true,
			get: () => selected,
			set: (value: AccessPoint | null) => {
				if (selected === value)
					return;

				selected = value;
				this.refresh();
			}
		});
	}

	async load(files: FileList): Promise<void> {
		if (files.length !== 1) {
			return;
		}

		const file = files.item(0);
		if (file != null) {
			const json = JSON.parse(await file.text()) as AppViewModel;
			this.restore(json);
		}
	}

	private restore(json: AppViewModel) {
		this.name = json.name;
		this.background = json.background;
		this.pixelated = json.pixelated;
		this.selected = json.selected ?? null;

		if (json.group_by) {
			this.group_by.ssid = json.group_by.ssid;
			this.group_by.frequency = json.group_by.frequency;
		}

		if (json.readings) {
			this.readings = json.readings.map(r => new Reading(r.id,
				new Point(r.location.x, r.location.y),
				r.signals.map(s => new Signal(s.mac, s.ssid, s.frequency, s.channel, s.strength))));
		}

		this.refresh();
	}

	async setBackground(files: FileList): Promise<void> {
		if (files.length !== 1) {
			this.background = "";
			return;
		}

		const file = files.item(0);
		if (file != null) {
			this.background = await this.background_parser?.read(file) ?? "";
		}
	}

	refresh(): void {
		// always pass the current readings and selection along; the renderer re-triangulates from scratch,
		// and clears the canvas when there are not enough points to form a triangle
		this.renderer?.render(this.mode, this.readings, this.selected);
	}

	resize(width: number, height: number): void {
		this.renderer?.resize(width, height);
		this.refresh();
	}

	deleteDataPoint(index: number): void {
		this.readings.splice(index, 1);
		this.refresh();
	}

	clearAllDataPoints(): void {
		this.readings = [];
		this.refresh();
	}
}
