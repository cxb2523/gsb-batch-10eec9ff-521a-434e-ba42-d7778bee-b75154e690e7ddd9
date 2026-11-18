import { Point, InitPoint, PreRoundedPoint, RoundedPoint } from "./types"
import { getLength, getAngles, PI, min, max, cos, sin } from "./utils"
import { getSegments } from "./segments"



// A spike ( zero main angle ) is kept as EPSILON internally, because the arc
// center is calculated through "radius / sin( main / 2 )". For main -> 0 that
// expression tends to the offset, which is exactly what a spike needs.
// getAngles snaps every real angle to 0 or PI, so EPSILON can never be a real
// angle, and it is exposed back as an exact 0 in the output.
const SPIKE_MAIN = Number.EPSILON

// raw ( not rounded ) length, in/out points are placed with it, so a length
// rounded up can never push them outside their side
const getDistance = (
  A: Point, B: Point,
) => Math.sqrt((B.x - A.x) * (B.x - A.x) + (B.y - A.y) * (B.y - A.y))

// value / divisor, but a zero divisor ( a straight point takes no side space )
// is not a restriction, while an empty ( zero ) side is.
// Keeps NaN ( 0 / 0 ) out of every radius calculation.
const safeDiv = (value: number, divisor: number) => (
  divisor > 0 ? value / divisor : value > 0 ? Infinity : 0
)



const roundPolygon = (
  points: InitPoint[],
  radius: number = 0,
): RoundedPoint[] => {

  const
    len = points.length,
    preRoundedPoints: PreRoundedPoint[] = [],
    limPoints: PreRoundedPoint[] = [],
    zeroLimPoints: PreRoundedPoint[] = []

  // prepare points, calc angles
  points.forEach((curr, id) => {

    const
      prev = points[(id - 1 + len) % len],
      next = points[(id + 1) % len],
      // raw lengths place in/out points, rounded ones detect overlapped points
      prevlen = getDistance(prev, curr),
      nextlen = getDistance(curr, next),
      angle = getAngles(prev, curr, next, getLength(prev, curr), getLength(curr, next))

    if (angle.main === 0) {
      angle.main = SPIKE_MAIN
      angle.vel = Number.MAX_SAFE_INTEGER
    }
    else if (angle.main === PI) angle.vel = 0

    const preRoundedPoint: PreRoundedPoint = {
      x: curr.x,
      y: curr.y,
      angle,
      offset: 0,
      arc: {
        radius,
        hit: radius,
        // limit lim to prevent offset to become bigger than prev/next length
        lim: min(nextlen / angle.vel, prevlen / angle.vel, curr.r || 0),
      },
      in: { length: prevlen, rest: prevlen },
      out: { length: nextlen, rest: nextlen },
      locked: false,
      id,
      get prev() { return preRoundedPoints[(id - 1 + len) % len] },
      get next() { return preRoundedPoints[(id + 1) % len] },
    }

    // if point overlaps another point
    if (isNaN(angle.main)) {
      angle.main = 0
      angle.bis = angle.prev || angle.next // :)
      zeroLimPoints.push(preRoundedPoint)
    }
    // spread points into either limited or zero-limited lists
    // ( is limited if point has own radius to round )
    else if (typeof curr.r === "number") {
      if (curr.r === 0) zeroLimPoints.push(preRoundedPoint)
      else limPoints.push(preRoundedPoint)
    }

    preRoundedPoints.push(preRoundedPoint)
  })


  // lock (overlapped | zero radius) points
  zeroLimPoints.forEach((p) => {
    p.angle.vel = 0
    p.arc.radius = 0
    lockPoint(p)
  })


  // calc collision radius for each point
  preRoundedPoints.forEach((p) => {
    p.arc.hit = getHit(p)
  })


  // points with an own "r" take the space first, so a common radius can never
  // squeeze them, then the common radius only uses what is left
  let minHitPoint = getMinHit(limPoints)
  while (minHitPoint) {
    calcLimitRadius(minHitPoint)
    minHitPoint = getMinHit(limPoints)
  }


  // calc common radius and its offsets
  minHitPoint = getMinHit(preRoundedPoints)
  while (minHitPoint) {
    calcCommonRadius(minHitPoint, radius)
    minHitPoint = getMinHit(preRoundedPoints)
  }


  // final calc coordinates
  const roundedPoints = preRoundedPoints.map((p) => {

    const bislen = p.arc.radius / sin(p.angle.main / 2)

    return {
      id: p.id,
      x: p.x,
      y: p.y,
      angle: {
        // a spike is exposed as an exact 0 ( it is kept as SPIKE_MAIN )
        main: p.angle.main === SPIKE_MAIN ? 0 : p.angle.main,
        prev: p.angle.prev,
        next: p.angle.next,
        bis: p.angle.bis,
        dir: p.angle.dir,
      },
      offset: p.offset,
      arc: {
        radius: p.arc.radius,
        x: p.x + (cos(p.angle.bis) * bislen || 0),
        y: p.y + (sin(p.angle.bis) * bislen || 0),
      },
      // in/out are placed along the side itself, so they always stay on the
      // segment, even for a rounded side length
      in: {
        length: p.in.length,
        x: p.in.length ? p.x + (p.prev.x - p.x) * (p.offset / p.in.length) : p.x,
        y: p.in.length ? p.y + (p.prev.y - p.y) * (p.offset / p.in.length) : p.y,
      },
      out: {
        length: p.out.length,
        x: p.out.length ? p.x + (p.next.x - p.x) * (p.offset / p.out.length) : p.x,
        y: p.out.length ? p.y + (p.next.y - p.y) * (p.offset / p.out.length) : p.y,
      },
      get prev() { return roundedPoints[(p.id - 1 + len) % len] },
      get next() { return roundedPoints[(p.id + 1) % len] },
    }
  })

  return roundedPoints
}



// the radius that makes two neighbor offsets exactly fill a shared side
const getHit = (
  curr: PreRoundedPoint,
) => (
  min(
    safeDiv(curr.out.rest, curr.angle.vel + curr.next.angle.vel),
    safeDiv(curr.in.rest,  curr.angle.vel + curr.prev.angle.vel),
  )
)



const calcLimitRadius = (
  curr: PreRoundedPoint,
) => {

  const { prev, next } = curr

  // straight angle has zero offset, so the radius only has to fit the free
  // length of the sides ( avoids rest / 0 = NaN )
  if (curr.angle.vel === 0) curr.arc.radius = max(min(curr.arc.lim, curr.arc.hit), 0)

  // if prev locked
  else if (prev.locked && !next.locked) curr.arc.radius = min(
    max(
      (curr.out.length - (next.arc.lim * next.angle.vel)) / curr.angle.vel,
      curr.out.length / (curr.angle.vel + next.angle.vel),
    ),
    curr.in.rest / curr.angle.vel,
    curr.arc.lim,
  )

  // if next locked
  else if (next.locked && !prev.locked) curr.arc.radius = min(
    max(
      (curr.in.length - (prev.arc.lim * prev.angle.vel)) / curr.angle.vel,
      curr.in.length / (curr.angle.vel + prev.angle.vel),
    ),
    curr.out.rest / curr.angle.vel,
    curr.arc.lim,
  )

  // if BOTH locked
  else if (next.locked && prev.locked) curr.arc.radius = min(
    curr.in.rest / curr.angle.vel,
    curr.out.rest / curr.angle.vel,
    curr.arc.lim,
  )

  // if NONE locked
  else curr.arc.radius = min(
    max(
      (curr.in.length - (prev.arc.lim * prev.angle.vel)) / curr.angle.vel,
      curr.in.length / (curr.angle.vel + prev.angle.vel),
    ),
    max(
      (curr.out.length - (next.arc.lim * next.angle.vel)) / curr.angle.vel,
      curr.out.length / (curr.angle.vel + next.angle.vel),
    ),
    curr.arc.lim,
  )

  // a shared side may already be exhausted ( rest <= 0 ) by a locked neighbor:
  // the radius then converges to 0 instead of becoming negative or NaN
  curr.arc.radius = clampRadius(curr, curr.arc.radius)

  lockPoint(curr)
}



const calcCommonRadius = (
  curr:   PreRoundedPoint,
  radius: number,
) => {

  if (radius > curr.arc.hit) {
    const { prev, next } = curr

    // safeDiv keeps a straight point's zero offset factor from producing
    // Infinity / NaN here
    // max(..., 0) cased by somehow getting rest = -2.71e-15 from calcLimit
    if (prev.locked && !next.locked) curr.arc.radius = max(min(
      safeDiv(curr.in.rest, curr.angle.vel),
      safeDiv(curr.out.length, curr.angle.vel + next.angle.vel),
      curr.arc.radius,
    ), 0)

    else if (next.locked && !prev.locked) curr.arc.radius = max(min(
      safeDiv(curr.out.rest, curr.angle.vel),
      safeDiv(curr.in.length, curr.angle.vel + prev.angle.vel),
      curr.arc.radius,
    ), 0)

    else if (next.locked && prev.locked) curr.arc.radius = max(min(
      safeDiv(curr.in.rest,  curr.angle.vel),
      safeDiv(curr.out.rest, curr.angle.vel),
      curr.arc.radius,
    ), 0)

    else curr.arc.radius = curr.arc.hit
  }

  // a shared side might be fully consumed by a locked neighbor: the radius
  // then converges to 0 instead of becoming negative or NaN
  curr.arc.radius = clampRadius(curr, curr.arc.radius)

  lockPoint(curr)
}



// make a radius respect the remaining side length, never go negative or NaN,
// and converge to 0 when a neighbor has already consumed the shared side
const clampRadius = (
  curr: PreRoundedPoint,
  value: number,
) => {
  // negative, zero and NaN ( 0 / 0 ) all converge to 0
  if (!(value > 0)) return 0

  // a straight point is tangent at the vertex, so it takes no side space and
  // its radius only matters as long as the sides are not exhausted
  if (curr.angle.vel === 0) return max(min(value, curr.arc.hit), 0)

  // offset = radius * vel, so this keeps both offsets inside the free space
  // ( a fully consumed side gives rest <= 0, hence the radius converges to 0 )
  return max(min(
    value,
    safeDiv(curr.in.rest,  curr.angle.vel),
    safeDiv(curr.out.rest, curr.angle.vel),
  ), 0)
}



const lockPoint = (curr: PreRoundedPoint) => {
  const { prev, next } = curr

  // a radius must always be a finite non-negative number
  if (!Number.isFinite(curr.arc.radius) || curr.arc.radius < 0) curr.arc.radius = 0

  // offset = radius * vel, and clampRadius guarantees it fits the free length
  // of both sides; a straight point ( vel = 0 ) is tangent at the vertex
  curr.offset = curr.angle.vel === 0 ? 0 : curr.arc.radius * curr.angle.vel

  prev.out.rest -= curr.offset
  curr.in.rest  -= curr.offset
  curr.out.rest -= curr.offset
  next.in.rest  -= curr.offset

  curr.locked = true

  // to get right getMinHit then
  // ( safeDiv keeps a straight neighbor's zero offset factor from making NaN )
  prev.arc.hit = min(
    safeDiv(prev.in.length, prev.angle.vel + prev.prev.angle.vel),
    safeDiv(prev.in.rest, prev.angle.vel),
    safeDiv(prev.out.rest, prev.angle.vel),
  )
  next.arc.hit = min(
    safeDiv(next.out.length, next.angle.vel + next.next.angle.vel),
    safeDiv(next.out.rest, next.angle.vel),
    safeDiv(next.in.rest, next.angle.vel),
  )
}



const getMinHit = (
  arr: PreRoundedPoint[],
) => (
  arr.reduce((min: PreRoundedPoint | null, p) =>
    p.locked ? min : !min ? p : p.arc.hit < min.arc.hit ? p : min,
  null))


export {
  roundPolygon as default,
  getSegments,

  type Point,
  type InitPoint,
  type RoundedPoint,
}
