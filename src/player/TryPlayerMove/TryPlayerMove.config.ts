/**
 * @license
 * @unsurf/cs-movement — Counter-Strike style movement physics
 * Copyright 2026 unsurf
 * SPDX-License-Identifier: Apache-2.0
 */
export const MAX_CLIP_PLANES = 5;
export const NUM_BUMPS = 4; // numbumps: bump up to four times per move
/**
 * Sweeps covering less of the move than this are treated as covering none of
 * it for integration/time bookkeeping (their fraction is rounded to 0 before
 * it feeds the distance maths). It does NOT mean the mover was stuck: the
 * tick is still considered to have advanced if any sweep reported a positive
 * fraction, so a wall-projected slide is never wiped for being tiny.
 */
export const MINIMUM_MOVE_FRACTION = 0.0001;
/** |normal.y| below this is treated as a perfectly vertical wall (EFFECTIVELY_HORIZONTAL_NORMAL_Z). */
export const EFFECTIVELY_VERTICAL_NORMAL_Y = 0.0001;
