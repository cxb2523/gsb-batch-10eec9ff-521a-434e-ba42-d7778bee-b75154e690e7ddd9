import { InitPoint } from "../types"
import { round, getLength, getClockDir, getAngles, PI, TAU, min, clamp, max, cos, sin, atan2 } from "../utils"


test("round", () => {
  expect(round(0 + 0.1)).toBeCloseTo(1 - 0.9, 10)
})

test("Math", () => {
  expect(PI).toBe(Math.PI)
  expect(TAU).toBe(Math.PI * 2)
  expect(min).toBe(Math.min)
  expect(max).toBe(Math.max)
  expect(cos).toBe(Math.cos)
  expect(sin).toBe(Math.sin)
  expect(atan2).toBe(Math.atan2)
})

test("clamp", () => {
  expect(clamp(2, 0, 1)).toBe(1)
  expect(clamp(-1, 0, 1)).toBe(0)
  expect(clamp(0.5, 0, 1)).toBe(0.5)
})

test("getLength", () => {
  expect(getLength({ x: 0, y: 0 }, { x: 1, y: 1 })).toBe(round(Math.SQRT2))
})



test("getClockDir -> 1", () => {
  expect(getClockDir(Math.PI, Math.PI * 1.25)).toBe(1)
})
test("getClockDir -> -1", () => {
  expect(getClockDir(0, -Math.PI * 0.25)).toBe(-1)
})



const points = [
  { x: 1, y: 1 }, { x: 0, y: 0 }, { x: 1, y: 0 },
] as [ InitPoint, InitPoint, InitPoint ]

const lengths = [
  getLength(points[0], points[1]),
  getLength(points[1], points[2]),
] as [ number, number ]

test("getAngles", () => {
  const data = getAngles(...points, ...lengths)
  const vel = 1 / Math.tan(data.main / 2)

  expect(data.prev).toBeCloseTo(Math.PI / 4, 8)
  expect(data.main).toBeCloseTo(Math.PI / 4, 8)
  expect(data.next).toBeCloseTo(0, 8)
  expect(data.bis).toBeCloseTo(Math.PI / 8, 8)
  expect(data.vel).toBeCloseTo(vel, 8)
  expect(data.dir).toBe(-1)
})

const getAnglesOf = (prev: InitPoint, curr: InitPoint, next: InitPoint) => (
  getAngles(prev, curr, next, getLength(prev, curr), getLength(curr, next))
)

test("getAngles -> exactly PI for collinear points", () => {
  // law of cosines over rounded lengths gave up to 1e-3 off PI at small scales
  [ 1e-3, 1, 1e4 ].forEach((s) => {
    for (let i = 1; i < 50; i++) {
      const data = getAnglesOf(
        { x: 0, y: 0 },
        { x: i * 0.1 * s, y: i * 0.3 * s },
        { x: (i + 7) * 0.1 * s, y: (i + 7) * 0.3 * s },
      )
      expect(data.main).toBe(Math.PI)
      expect(data.vel).toBe(1 / Math.tan(Math.PI / 2))
    }
  })
})

test("getAngles -> exactly 0 for a spike", () => {
  const data = getAnglesOf({ x: 0.3, y: 0.9 }, { x: 0, y: 0 }, { x: 0.1, y: 0.3 })
  expect(data.main).toBe(0)
})

test("getAngles -> NaN for overlapped points", () => {
  expect(getAnglesOf({ x: 1, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 3 }).main).toBeNaN()
  expect(getAnglesOf({ x: 0, y: 0 }, { x: 3e-11, y: 0 }, { x: 0.0569135387, y: 1 }).main).toBeNaN()
})