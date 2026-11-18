import { Point, RoundedPoint } from "./types"
import { cos, PI, sin } from "./utils"


export const getSegments = (
  points: RoundedPoint[],
  type: "LENGTH" | "AMOUNT",
  opt: number,
) => (

  points.reduce((segmented: Point[], point) => {
    const
      { x, y, angle: { prev, next }, arc: { x: rx, y: ry, radius }} = point,
      dir = point.angle.dir * -1,
      startangle = prev + dir * PI / 2,
      angle = (dir * PI + next - prev) % PI,
      amount = type === "LENGTH" ? Math.round(dir * angle * radius / opt) : opt,
      unitangle = angle / amount,
      vertices: Point[] = []

    // a point whose radius was pressed to 0 ( or any invalid one ) has no arc,
    // so it is represented by its vertex only, never by NaN coordinates
    if (!(radius > 0) || !Number.isFinite(radius)) return segmented.concat({ x, y })

    // straight points ( angle === 0 ), AMOUNT = 0 and non-positive or infinite
    // amounts don't produce an arc either
    if (!Number.isFinite(amount) || amount <= 0 || !unitangle) return segmented.concat({ x, y })

    for (let i = 0; i <= amount; i++) {
      vertices.push({
        x: rx + cos(startangle + unitangle * i) * radius,
        y: ry + sin(startangle + unitangle * i) * radius,
      })
    }

    return segmented.concat(vertices)
  }, [])
)