import type { CSSProperties } from 'react'
import type { Color } from '@shared/domain'

const COLOR_VALUES: Record<Color, string> = {
  gray: 'oklch(0.62 0.01 260)',
  red: 'oklch(0.63 0.2 27)',
  orange: 'oklch(0.7 0.17 52)',
  amber: 'oklch(0.77 0.15 80)',
  green: 'oklch(0.67 0.14 152)',
  teal: 'oklch(0.69 0.11 192)',
  blue: 'oklch(0.63 0.15 252)',
  indigo: 'oklch(0.58 0.16 277)',
  violet: 'oklch(0.61 0.18 302)',
  pink: 'oklch(0.67 0.18 352)',
}

/** Exposes a palette color as the `--swatch` CSS variable, for classes like `bg-(--swatch)`. */
export const swatch = (color: Color) => ({ '--swatch': COLOR_VALUES[color] }) as CSSProperties
