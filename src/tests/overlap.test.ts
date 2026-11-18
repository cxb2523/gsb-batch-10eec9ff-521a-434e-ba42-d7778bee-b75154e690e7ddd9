import roundPolygon, { getSegments } from ".."



// the distance between two input points ( the real side length )
const sideLength = (
  a: { x: number, y: number }, b: { x: number, y: number },
) => Math.sqrt((b.x - a.x) * (b.x - a.x) + (b.y - a.y) * (b.y - a.y))

// a point lies on the [ a, b ] segment, perpendicular and longitudinal checks
const expectOnSide = (
  side: { x: number, y: number, length: number },
  a: { x: number, y: number }, b: { x: number, y: number },
) => {
  const
    abx = b.x - a.x, aby = b.y - a.y,
    apx = side.x - a.x, apy = side.y - a.y,
    cross = abx * apy - aby * apx,
    dot = apx * abx + apy * aby,
    l2 = abx * abx + aby * aby,
    l = Math.sqrt(l2),
    tol = 1e-9 * Math.max(l, 1)

  expect(Math.abs(cross)).toBeLessThanOrEqual(tol * l)
  expect(dot).toBeGreaterThanOrEqual(-tol)
  expect(dot).toBeLessThanOrEqual(l2 + tol)
  expect(side.length).toBeCloseTo(l)
}



// a point with an oversized own radius next to a very close neighbor:
// both roundings can't fit the short shared side, so one of them must
// converge to zero instead of going negative or overlapping the other
test("neighbor roundings must never overlap on a shared side", () => {
  const polygons = [
    [{ x: 0, y: 0, r: 1000 }, { x: 0.5, y: 0 }, { x: 10, y: 10 }],
    [{ x: 0, y: 0, r: 1000 }, { x: 0.001, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }, { x: 0, y: 5 }],
    [{ x: 0, y: 0, r: 5 }, { x: 1e-6, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }, { x: 0, y: 5 }],
    [
      { x: 0, y: 0, r: 1000 }, { x: 0.001, y: 0 }, { x: 0.001, y: 10, r: 1000 },
      { x: 0.002, y: 10 }, { x: 0.002, y: 0, r: 1000 }, { x: 0, y: -10 },
    ],
  ]

  polygons.forEach((points) => {
    [ 0, 0.001, 1, 1000, 1e6 ].forEach((radius) => {
      const rounded = roundPolygon(points, radius)
      rounded.forEach((p, i) => {
        const next = rounded[(i + 1) % rounded.length]
        expect(p.offset).toBeGreaterThanOrEqual(0)
        expect(p.arc.radius).toBeGreaterThanOrEqual(0)
        expect(p.offset + next.offset)
          .toBeLessThanOrEqual(sideLength(points[i], points[(i + 1) % points.length]) + 1e-9)
      })
    })
  })
})

test("a fully consumed side should converge the other end to zero, not negative or NaN", () => {
  // point 0 rounds over the whole ( short ) 0-1 side
  const rounded = roundPolygon([
    { x: 0, y: 0, r: 1000 }, { x: 1, y: 0 }, { x: 0, y: 1 },
  ], 1000)

  expect(rounded[0].offset).toBeCloseTo(1)
  expect(rounded[1].offset).toBe(0)
  expect(rounded[1].arc.radius).toBe(0)
  expect(Number.isNaN(rounded[1].offset) || Number.isNaN(rounded[1].arc.radius)).toBe(false)
})

test("points with an own radius must not be squeezed by the common radius", () => {
  const points = [
    { x: 0, y: 0, r: 2 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 },
  ]

  // the common radius can't touch a point that has its own "r"
  const withCommon = roundPolygon(points, 1)
  const withoutCommon = roundPolygon(points, 0)

  expect(withCommon[0].offset).toBeCloseTo(withoutCommon[0].offset)
  expect(withCommon[0].arc.radius).toBeCloseTo(withoutCommon[0].arc.radius)
})

test("the common radius may only use the length left by points with own radius", () => {
  // point 0 takes the whole 0-1 side, so point 1 can't round into it
  const rounded = roundPolygon([
    { x: 0, y: 0, r: 1000 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 },
  ], 1000)

  expect(rounded[0].offset).toBeCloseTo(1)
  expect(rounded[1].offset).toBe(0)
  expect(rounded[1].arc.radius).toBe(0)
})

test("in/out coordinates must always stay on their sides", () => {
  const polygons = [
    [{ x: 0.5, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }, { x: 0, y: 0 }],
    [{ x: 0, y: 0, r: 200 }, { x: 50, y: 0, r: 90 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }],
    [{ x: 0, y: 0, r: 1000 }, { x: 0.001, y: 0 }, { x: 0.001, y: 10, r: 1000 }, { x: 0, y: 10 }],
    [{ x: 1, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 2 }, { x: 1, y: 1 }, { x: 0, y: 1 }, { x: 1, y: 1 }],
  ]

  polygons.forEach((points) => {
    [ 0, Number.EPSILON, 1, 1000 ].forEach((radius) => {
      const rounded = roundPolygon(points, radius)
      rounded.forEach((p, i) => {
        expectOnSide(p.in, points[(i - 1 + points.length) % points.length], points[i])
        expectOnSide(p.out, points[i], points[(i + 1) % points.length])
      })
    })
  })
})

test("a spike should expose angle.main === 0 and a collinear point === Math.PI", () => {
  // point 1 is a spike ( prev and next are on the same side of it )
  const spike = roundPolygon([
    { x: 2, y: 0 }, { x: 1, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 2 }, { x: 2, y: 2 },
  ], 0.5)
  expect(spike[1].angle.main).toBe(0)

  // point 1 is collinear ( prev and next are on the opposite sides )
  const collinear = roundPolygon([
    { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 1 }, { x: 0, y: 1 },
  ], 0.5)
  expect(collinear[1].angle.main).toBe(Math.PI)
  expect(collinear[1].offset).toBe(0)
})

test("getSegments should return only the vertex for a point with a zero radius", () => {
  // points 1 and 2 are overlapped, so both have a zero radius
  const rounded = roundPolygon([
    { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 },
  ], 0.5)

  expect(rounded[1].arc.radius).toBe(0)
  expect(rounded[2].arc.radius).toBe(0)

  ;[ "AMOUNT", "LENGTH" ].forEach((type) => {
    const segments = getSegments(rounded, type as "AMOUNT" | "LENGTH", 2)

    segments.forEach((segment) => {
      expect(Number.isFinite(segment.x) && Number.isFinite(segment.y)).toBe(true)
    })

    // every zero-radius point contributes exactly its own vertex ( once ),
    // points 1 and 2 sit at the same place, so there are 2 such vertices
    const zeroRadiusPoints = rounded.filter((p) => p.arc.radius === 0)
    expect(zeroRadiusPoints.length).toBe(2)
    expect(segments.filter((s) => s.x === 1 && s.y === 0).length).toBe(2)
  })
})

test("degenerate inputs should not produce negative or NaN values", () => {
  const polygons = [
    [{ x: 5, y: 5 }],
    [{ x: 0, y: 0 }, { x: 10, y: 0 }],
    [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }],
    [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }],
    [{ x: 0, y: 0, r: 5 }, { x: 1, y: 0, r: 5 }, { x: 2, y: 0, r: 5 }],
  ]

  polygons.forEach((points) => {
    [ 0, 1, 1e6 ].forEach((radius) => {
      roundPolygon(points, radius).forEach((p) => {
        expect(Number.isFinite(p.offset) && p.offset >= 0).toBe(true)
        expect(Number.isFinite(p.arc.radius) && p.arc.radius >= 0).toBe(true)
        expect(Number.isFinite(p.arc.x) && Number.isFinite(p.arc.y)).toBe(true)
        expect([ p.in.x, p.in.y, p.out.x, p.out.y ].every(Number.isFinite)).toBe(true)
      })
    })
  })
})
