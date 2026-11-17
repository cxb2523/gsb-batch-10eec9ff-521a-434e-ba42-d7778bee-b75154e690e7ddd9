import { InitPoint } from "./types"

export const round = (n: number) => Math.round(n * 1e10) / 1e10

export const getLength = (
  A: InitPoint, B: InitPoint,
) => round(Math.sqrt((B.x - A.x) * (B.x - A.x) + (B.y - A.y) * (B.y - A.y)))

export const PI = Math.PI, TAU = PI * 2
export const ANGLE_EPS = 1e-9
export const min = Math.min
export const max = Math.max
export const cos = Math.cos
export const sin = Math.sin
export const atan2 = Math.atan2
export const clamp = (value: number, min_value: number, max_value: number) => max(min_value, min(max_value, value))

export const getClockDir = (
  angle1: number, angle2: number,
) => {
  const diff = angle2 - angle1
  return (
    (diff > PI && diff < TAU) ||
    (diff < 0  && diff > -PI)
      ? -1 : 1
  )
}

export const getAngles = (
  prevpoint: InitPoint,
  currpoint: InitPoint,
  nextpoint: InitPoint,
  prevlen: number,
  nextlen: number,
) => {
  const
    ax = prevpoint.x - currpoint.x, ay = prevpoint.y - currpoint.y,
    bx = nextpoint.x - currpoint.x, by = nextpoint.y - currpoint.y,
    prev = atan2(ay, ax),
    next = atan2(by, bx),
    // atan2 of cross/dot stays exact near 0 and PI, unlike acos of rounded lengths
    // keep NaN for overlapped points ( zero length side ), atan2(0, 0) would give 0
    raw = prevlen && nextlen ? Math.abs(atan2(ax * by - ay * bx, ax * bx + ay * by)) : NaN,
    // snap remaining float noise so `=== PI` / `=== 0` checks hold
    main = PI - raw < ANGLE_EPS ? PI : raw < ANGLE_EPS ? 0 : raw,
    vel = 1 / Math.tan(main / 2),
    dir = getClockDir(prev, next),
    bis = prev + dir * main / 2

  return { prev, next, main, vel, dir, bis }
}