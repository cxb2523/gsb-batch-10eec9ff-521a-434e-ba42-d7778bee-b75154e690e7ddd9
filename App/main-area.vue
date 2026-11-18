<template>
	<main>
		<div
			:class="{ pixelated: state.pixelated }"
			:style="{ 'background-image': `url(${state.background})` }"
			class="background"
		></div>
		<canvas id="webglcanvas" :disabled="!enabled" @click="add($event)"></canvas>
		<data-point
			v-for="(reading, index) in state.readings"
			:key="index"
			:index="index"
			:reading="reading"
			:selected="state.selected"
			:mode="state.mode"
		/>
	</main>
</template>

<script lang="ts">
import { defineComponent } from "vue";

import DataPoint from "./data-point.vue";
import Point from "./Point";
import Reading from "./Reading";
import SharedState from "./SharedState";

export default defineComponent({
	components: {
		"data-point": DataPoint
	},
	props: {
		enabled: Boolean
	},
	data: () => ({
		state: SharedState,
		resize_handler: null as (() => void) | null
	}),
	mounted(): void {
		this.resize_handler = () => this.resize();
		window.addEventListener("resize", this.resize_handler);
		this.resize();
	},
	beforeUnmount(): void {
		if (this.resize_handler != null)
			window.removeEventListener("resize", this.resize_handler);
	},
	methods: {
		add(e: MouseEvent): void {
			if (!this.enabled) return;

			const location = new Point(e.offsetX, e.offsetY);
			const reading = new Reading(
				this.state.readings.length,
				location,
				this.state.current.signals.concat()
			);
			this.state.readings.push(reading);
			this.refresh();
		},
		resize(): void {
			const canvas = document.getElementById("webglcanvas") as HTMLCanvasElement | null;
			if (canvas == null) {
				this.refresh();
				return;
			}

			// keep the canvas pixel size in sync with its displayed size so the heat map is not stretched or offset
			const width = canvas.clientWidth;
			const height = canvas.clientHeight;
			canvas.width = width;
			canvas.height = height;

			this.state.resize(width, height);
		},
		refresh(): void {
			this.state.refresh();
		}
	}
});
</script>

<style>
main {
	flex-grow: 1;
	position: relative;
	overflow-x: hidden;
}

div.background,
canvas {
	position: absolute;
	width: 100%;
	height: 100%;
}

div.background {
	background-size: contain;
	background-position: center;
	background-repeat: no-repeat;
}

canvas:not([disabled]) {
	cursor: pointer;
}

.pixelated {
	image-rendering: crisp-edges;
	image-rendering: pixelated;
}
</style>