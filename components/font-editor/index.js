import { ATLAS_CELL_SIZE, ATLAS_GRID_SIZE } from 'components/ascii/characters'
import { AsciiContext } from 'components/ascii/context'
import { useContext, useEffect, useMemo, useRef } from 'react'
import { CanvasTexture, NearestFilter, RepeatWrapping } from 'three'
import s from './font-editor.module.scss'

export function FontEditor() {
  const el = useRef()

  const invert = false
  const {
    characters,
    effectiveCharacters,
    fontSize,
    effectiveCharactersCount,
    set,
  } = useContext(AsciiContext)

  const canvasSize = ATLAS_GRID_SIZE * ATLAS_CELL_SIZE // 1024
  const canvasDebug = useMemo(() => document.createElement('canvas'), [])
  const contextDebug = useMemo(
    () => canvasDebug.getContext('2d'),
    [canvasDebug]
  )

  const canvas = useMemo(() => document.createElement('canvas'), [])
  const context = useMemo(() => canvas.getContext('2d'), [canvas])
  const texture = useMemo(() => {
    const texture = new CanvasTexture(canvas)
    texture.minFilter = texture.magFilter = NearestFilter
    texture.wrapS = texture.wrapT = RepeatWrapping

    return texture
  }, [canvas])

  useEffect(() => {
    set({ charactersTexture: texture })
  }, [texture])

  useEffect(() => {
    el.current.appendChild(canvasDebug)
    el.current.appendChild(canvas)

    return () => {
      canvas.remove()
      canvasDebug.remove()
    }
  }, [])

  useEffect(() => {
    canvasDebug.width = canvasSize
    canvasDebug.height = canvasSize

    canvas.width = canvasSize
    canvas.height = canvasSize
  }, [canvasSize])

  function render() {
    if (!context) return
    context.clearRect(0, 0, canvasSize, canvasSize)
    contextDebug.clearRect(0, 0, canvasSize, canvasSize)
    context.font = `${fontSize}px CustomFont, monospace`
    context.textAlign = 'center'
    context.textBaseline = 'middle'

    // Draw exactly as many cells as the shader is allowed to index, so the
    // atlas and the grey-level binning always use the same set of glyphs.
    const step = 256 / Math.max(1, effectiveCharactersCount - 1)

    for (let i = 0; i < effectiveCharactersCount; i++) {
      const x = i % ATLAS_GRID_SIZE
      const y = Math.floor(i / ATLAS_GRID_SIZE)
      let c = step * i

      if (invert) {
        c = 256 - c
      }

      contextDebug.fillStyle = `rgb(${c},${c},${c})`
      contextDebug.fillRect(
        x * ATLAS_CELL_SIZE,
        y * ATLAS_CELL_SIZE,
        ATLAS_CELL_SIZE,
        ATLAS_CELL_SIZE
      )
    }

    effectiveCharacters.split('').forEach((character, i) => {
      const x = i % ATLAS_GRID_SIZE
      const y = Math.floor(i / ATLAS_GRID_SIZE)

      context.fillStyle = 'white'
      context.fillText(
        character,
        x * ATLAS_CELL_SIZE + ATLAS_CELL_SIZE / 2,
        y * ATLAS_CELL_SIZE + ATLAS_CELL_SIZE / 2
      )
    })

    texture.needsUpdate = true
  }

  useEffect(() => {
    render()
  }, [effectiveCharacters, effectiveCharactersCount, context, invert, fontSize])

  return (
    <div ref={el} className={s.font}>
      <input
        value={characters}
        onKeyDown={({}) => {
          console.log('onKeydown')
        }}
        onChange={({ target }) => {
          set({ characters: target.value })
        }}
      />
    </div>
  )
}
