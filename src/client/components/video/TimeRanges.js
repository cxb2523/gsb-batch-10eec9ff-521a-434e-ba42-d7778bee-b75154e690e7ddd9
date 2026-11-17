/**
 * Creates a TimeRanges-like object ({ length, start(i), end(i) }) from a list
 * of [start, end] pairs, so every video source exposes buffered ranges through
 * the same interface as the native HTMLVideoElement.
 */
export default function createTimeRanges(ranges = []) {
    return {
        length: ranges.length,
        start: index => ranges[index][0],
        end: index => ranges[index][1],
    };
}
