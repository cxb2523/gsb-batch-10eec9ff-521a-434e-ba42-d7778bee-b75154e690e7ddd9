import { describe, expect, it } from "vitest";

import { MERGE_IOU_THRESHOLD, mergeModelResults } from "./merge";

import type { ObjectDetection, SegmentationMask } from "../types";
import type { DecodeResult } from "./decoders";

const box = (
  x: number,
  y: number,
  width: number,
  height: number,
): ObjectDetection["bbox"] => ({ x, y, width, height });

const detection = (
  label: string,
  confidence: number,
  bbox: ObjectDetection["bbox"],
): ObjectDetection => ({ label, confidence, bbox });

const maskFor = (
  detection: ObjectDetection,
  seed: number,
): SegmentationMask => ({
  label: detection.label,
  confidence: detection.confidence,
  bbox: detection.bbox,
  mask: new Uint8Array([seed, seed]),
  maskWidth: 2,
  maskHeight: 1,
});

describe("mergeModelResults", () => {
  it("keeps only the higher-confidence box and its mask for overlapping same-label detections across models", () => {
    // Detector model: one high-confidence "person" box
    const detected = detection("person", 0.9, box(10, 10, 50, 100));
    // Segmentation model: the same person, slightly larger box, lower score
    const segmented = detection("person", 0.7, box(12, 12, 48, 98));

    const detector: DecodeResult = { objects: [detected] };
    const segmenter: DecodeResult = {
      objects: [segmented],
      masks: [maskFor(segmented, 7)],
    };

    // Sanity-check the fixture actually overlaps beyond the threshold
    expect(MERGE_IOU_THRESHOLD).toBe(0.45);

    const merged = mergeModelResults([detector, segmenter], { maxResults: 10 });

    expect(merged.detections).toEqual([detected]);
    // The suppressed segmentation result must take its mask with it
    expect(merged.masks).toEqual([]);
  });

  it("keeps the higher-confidence detection's own mask when the segmenter wins", () => {
    const detected = detection("person", 0.6, box(10, 10, 50, 100));
    const segmented = detection("person", 0.85, box(11, 11, 50, 100));

    const merged = mergeModelResults(
      [
        { objects: [detected] },
        { objects: [segmented], masks: [maskFor(segmented, 3)] },
      ],
      { maxResults: 10 },
    );

    expect(merged.detections).toEqual([segmented]);
    expect(merged.masks).toHaveLength(1);
    expect(merged.masks[0].mask).toEqual(new Uint8Array([3, 3]));
    expect(merged.masks[0].bbox).toEqual(segmented.bbox);
  });

  it("keeps overlapping boxes of different labels", () => {
    const a = detection("person", 0.9, box(10, 10, 50, 100));
    const b = detection("dog", 0.7, box(12, 12, 48, 98));

    const merged = mergeModelResults(
      [{ objects: [a] }, { objects: [b], masks: [maskFor(b, 9)] }],
      { maxResults: 10 },
    );

    expect(merged.detections).toEqual([a, b]);
    expect(merged.masks).toEqual([maskFor(b, 9)]);
  });

  it("leaves a single model's detections and order unchanged", () => {
    // Decoders emit results already suppressed, ranked and capped, so merging
    // one model may not reorder or drop anything — including for NMS-free
    // decoders like RF-DETR, whose overlapping boxes must survive.
    const objects = [
      detection("person", 0.95, box(0, 0, 20, 40)),
      detection("dog", 0.8, box(100, 0, 20, 30)),
      detection("person", 0.6, box(200, 0, 20, 40)),
      // Overlaps the first "person" box: still kept, no cross-model merge
      detection("person", 0.4, box(1, 1, 20, 40)),
    ];

    const merged = mergeModelResults([{ objects }], { maxResults: 10 });

    expect(merged.detections).toHaveLength(objects.length);
    expect(merged.detections).toEqual(objects);
    expect(merged.masks).toEqual([]);
  });

  it("passes a single model's masks through with their buffers intact", () => {
    const objects = [
      detection("person", 0.9, box(0, 0, 10, 10)),
      detection("dog", 0.8, box(20, 0, 10, 10)),
    ];
    const masks = [maskFor(objects[0], 1), maskFor(objects[1], 2)];

    const merged = mergeModelResults([{ objects, masks }], {
      maxResults: 10,
    });

    expect(merged.detections).toEqual(objects);
    expect(merged.masks).toEqual(masks);
    // Same instances -> their buffers are still transferable via postMessage
    expect(merged.masks[0]).toBe(masks[0]);
    expect(merged.masks[1]).toBe(masks[1]);
  });

  it("truncates to maxResults after merging across models", () => {
    const first = detection("person", 0.9, box(0, 0, 10, 10));
    const second = detection("dog", 0.8, box(20, 0, 10, 10));
    const duplicate = detection("person", 0.5, box(0, 0, 10, 10));

    const merged = mergeModelResults(
      [{ objects: [first] }, { objects: [second, duplicate] }],
      { maxResults: 2 },
    );

    // The duplicate is suppressed, leaving exactly two candidates, both kept
    expect(merged.detections).toEqual([first, second]);
  });

  it("caps merged results at maxResults when nothing is suppressed", () => {
    const objects = [
      detection("person", 0.9, box(0, 0, 10, 10)),
      detection("dog", 0.8, box(20, 0, 10, 10)),
      detection("cat", 0.7, box(40, 0, 10, 10)),
    ];

    const merged = mergeModelResults([{ objects }], { maxResults: 2 });

    expect(merged.detections).toEqual(objects.slice(0, 2));
  });

  it("returns an empty output when no models ran", () => {
    expect(mergeModelResults([], { maxResults: 10 })).toEqual({
      detections: [],
      masks: [],
    });
  });
});
