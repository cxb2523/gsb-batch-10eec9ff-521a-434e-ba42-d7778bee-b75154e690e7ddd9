/**
 * TSL builds shader node graphs via chained calls; runtime.ts never executes the graph in
 * these tests (the renderer is stubbed). A callable, chainable Proxy therefore stands in
 * for every imported builder and node value, including the special TSL call syntax
 * `Fn(() => {...})()` used to build the material.
 */
type Chain = ((...args: unknown[]) => any) & Record<string | symbol, any>

function chainNode(): Chain {
  const node: any = (..._args: unknown[]) => node
  return new Proxy(node, {
    get(target, prop) {
      if (prop in target) return target[prop]
      target[prop] ??= chainNode()
      return target[prop]
    },
    apply() {
      return chainNode()
    },
  })
}

export const uniform = (initial: unknown) => ({ value: initial })

export const Fn = chainNode()
export const abs = chainNode()
export const clamp = chainNode()
export const dot = chainNode()
export const exp = chainNode()
export const float = chainNode()
export const fwidth = chainNode()
export const length = chainNode()
export const max = chainNode()
export const min = chainNode()
export const mix = chainNode()
export const normalize = chainNode()
export const oneMinus = chainNode()
export const pow = chainNode()
export const smoothstep = chainNode()
export const sqrt = chainNode()
export const texture = chainNode()
export const uv = chainNode()
export const vec2 = chainNode()
export const vec3 = chainNode()
export const vec4 = chainNode()
