import roundPolygon from ".."

const crossPoints = [
  { x: 1, y: 0 }, { x: 1, y: 1 },
  { x: 2, y: 1 }, { x: 1, y: 1 },
  { x: 1, y: 2 }, { x: 1, y: 1 },
  { x: 0, y: 1 }, { x: 1, y: 1 },
]
const crossToPoint = roundPolygon(crossPoints, Number.EPSILON)

test("a cross should round to a single point even with 'epsilon' radius", () => {
  crossToPoint.forEach((p, i) => {
    expect(p.offset).toBeCloseTo(i % 2 ? 0 : 1)
    expect(p.arc.radius).toBeCloseTo(0)
    expect(p.arc.x).toBeCloseTo(1)
    expect(p.arc.y).toBeCloseTo(1)
  })
})

const overlappedPoints = [
  { x: 0, y: 0 },
  { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 },
]
const overlappedToDrop = roundPolygon(overlappedPoints, 1)

test("a square with 2 overlapped points should round to a drop", () => {
  overlappedToDrop.forEach((p, i) => {
    const v = i > 1 ? 0.5 : 0
    expect(p.offset).toBeCloseTo(v)
    expect(p.arc.radius).toBeCloseTo(v)
    expect(p.arc.x).toBeCloseTo(v)
    expect(p.arc.y).toBeCloseTo(v)
  })
})

const squareWithSubdividedEdgePoints = [
  { x: 0.5, y: 0 },
  { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }, { x: 0, y: 0 },
]
const squareWithSubdividedEdgeToCircle = roundPolygon(squareWithSubdividedEdgePoints, 1)

test("a square with a subdivided by 2 top edge should round to a circle", () => {
  squareWithSubdividedEdgeToCircle.forEach((p, i) => {
    if (i) {
      expect(p.offset).toBeCloseTo(0.5)
      expect(p.arc.radius).toBeCloseTo(0.5)
      expect(p.arc.x).toBeCloseTo(0.5)
      expect(p.arc.y).toBeCloseTo(0.5)
    }
    else {
      expect(p.angle.main).toBeCloseTo(Math.PI)
      expect(p.offset).toBeCloseTo(0)
      expect(p.arc.radius).toBeCloseTo(0.5)
      expect(p.arc.x).toBeCloseTo(0.5)
      expect(p.arc.y).toBeCloseTo(-0.5)
    }
  })
})

// issue #2
const squareWithLimitedStraightPoint = (r: number) => [
  { x: 0, y: 0, r: 200 },
  { x: 50, y: 0, r }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 },
]

test("a straight point with own radius should get zero offset when its edge is consumed", () => {
  const offsets = roundPolygon(squareWithLimitedStraightPoint(1), 0).map((p) => p.offset)
  expect(offsets).toEqual([ 50, 0, 0, 0, 0 ])
})

test("a straight point with own radius should not unclamp its neighbors", () => {
  const rounded = roundPolygon(squareWithLimitedStraightPoint(90), 1000)
  rounded.forEach((p, i) => {
    expect(p.offset).toBeCloseTo(i === 1 ? 0 : 50)
    ;[ p.in, p.out ].forEach((side) => {
      expect(side.x).toBeGreaterThanOrEqual(-1e-9)
      expect(side.x).toBeLessThanOrEqual(100 + 1e-9)
      expect(side.y).toBeGreaterThanOrEqual(-1e-9)
      expect(side.y).toBeLessThanOrEqual(100 + 1e-9)
    })
  })
})

test("a straight point should expose angle.main === Math.PI", () => {
  const rounded = roundPolygon([
    { x: 0, y: 0 }, { x: 0.1, y: 0.3 }, { x: 0.7, y: 2.1 }, { x: -1, y: 1 },
  ], 0.1)
  expect(rounded[1].angle.main).toBe(Math.PI)
  expect(rounded[1].offset).toBe(0)
  expect(rounded[0].angle.main).not.toBe(Math.PI)
})

// points 0 and 1 have zero length after rounding, but their distances to point 2 differ
test("nearly overlapped points should still be treated as overlapped", () => {
  const rounded = roundPolygon([
    { x: 0, y: 0 }, { x: 3e-11, y: 0 },
    { x: 0.0569135387, y: 1 }, { x: -1, y: 1 },
  ], 1)
  rounded.forEach((p) => {
    expect(Number.isFinite(p.offset)).toBe(true)
    expect(Number.isFinite(p.arc.x) && Number.isFinite(p.arc.y)).toBe(true)
  })
  expect(rounded[0].arc.radius).toBe(0)
  expect(rounded[1].arc.radius).toBe(0)
})