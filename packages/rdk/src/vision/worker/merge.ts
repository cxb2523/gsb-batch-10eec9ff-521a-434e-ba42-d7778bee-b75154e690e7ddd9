// Cross-model result merging for frames that run more than one ONNX model.
// Decoders already suppress duplicates within their own model; this pass keeps
// the combined output clean when e.g. a detector and a segmentation model both
// report the same object.

import { iou } from "./decoders/nms";

import type { ObjectDetection, SegmentationMask } from "../types";
import type { DecodeResult } from "./decoders";

/** IoU threshold above which a lower-confidence same-label box is suppressed */
export const MERGE_IOU_THRESHOLD = 0.45;

/** Options controlling how per-model results are combined */
export type MergeOptions = {
  /** Maximum merged detections to return */
  maxResults: number;
  /** IoU suppression threshold (defaults to {@link MERGE_IOU_THRESHOLD}) */
  iouThreshold?: number;
};

/** A detection paired with the segmentation mask produced alongside it */
type MergedItem = {
  detection: ObjectDetection;
  mask?: SegmentationMask;
};

/** Merged frame output: detections plus the masks of the detections kept */
export type MergedResult = {
  detections: ObjectDetection[];
  masks: SegmentationMask[];
};

/**
 * Combine the decode results of every model that ran on a frame into a single
 * output.
 *
 * Detections from all models are pooled and greedily suppressed per label:
 * candidates are visited highest-confidence first and any box overlapping an
 * already-kept box of the same label with IoU greater than the threshold is
 * dropped. A suppressed detection takes its mask with it, so masks only ever
 * describe detections that survived. The merged list is then capped at
 * `maxResults`.
 *
 * With a single model the output is passed through untouched: decoders already
 * apply their own suppression rules (RF-DETR is deliberately NMS-free), so
 * re-running suppression here would change single-model results.
 */
export const mergeModelResults = (
  results: DecodeResult[],
  { maxResults, iouThreshold = MERGE_IOU_THRESHOLD }: MergeOptions,
): MergedResult => {
  // Single-model (or empty) frames are not a merge: keep the decoder's output
  // verbatim. Mask buffers stay the original instances so they remain
  // transferable.
  if (results.length <= 1) {
    const objects = results[0]?.objects ?? [];
    const masks = results[0]?.masks ?? [];
    const detections = objects.slice(0, maxResults);
    return {
      detections,
      // Keep the original mask instances (and their buffers) for transfer;
      // drop any beyond the detections that survived the cap.
      masks:
        masks.length > detections.length
          ? masks.slice(0, detections.length)
          : masks,
    };
  }

  const items: MergedItem[] = [];

  for (const result of results) {
    const objects = result.objects ?? [];
    const masks = result.masks ?? [];

    // Decoders emit masks positionally aligned with their objects, so index i
    // is the mask that belongs to object i (if the model segments at all).
    for (let i = 0; i < objects.length; i++) {
      items.push({ detection: objects[i], mask: masks[i] });
    }
  }

  // Highest confidence first. The sort is stable, so ties keep decoder/model
  // order and single-model output ordering is preserved.
  items.sort((a, b) => b.detection.confidence - a.detection.confidence);

  const kept: MergedItem[] = [];
  for (const item of items) {
    if (kept.length >= maxResults) break;

    const suppressed = kept.some(
      (existing) =>
        existing.detection.label === item.detection.label &&
        iou(existing.detection.bbox, item.detection.bbox) > iouThreshold,
    );
    if (!suppressed) kept.push(item);
  }

  return {
    detections: kept.map((item) => item.detection),
    // Mask-bearing detections keep their relative order, so each mask still
    // pairs with the detection it describes.
    masks: kept.flatMap((item) => (item.mask ? [item.mask] : [])),
  };
};
