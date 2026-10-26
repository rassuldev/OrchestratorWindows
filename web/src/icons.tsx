// One small authored icon set: 16px grid, 1.75 stroke, round caps.
import type { ReactNode } from 'react'

const PATHS = {
  check: <path d="M3.5 8.5l3 3 6-7" />,
  cross: <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />,
  pause: <path d="M6 3.5v9M10 3.5v9" />,
  play: <path d="M5 3.5v9l7-4.5z" />,
  alert: (
    <>
      <path d="M8 2.5l6 11H2z" />
      <path d="M8 7v2.5M8 11.6v.1" />
    </>
  ),
  clock: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 5v3.2l2 1.3" />
    </>
  ),
  stop: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M4.2 11.8l7.6-7.6" />
    </>
  ),
  external: <path d="M9.5 3h3.5v3.5M13 3L7.5 8.5M11.5 9.5v3.5h-8.5v-8.5h3.5" />,
  plus: <path d="M8 3v10M3 8h10" />,
  back: <path d="M9.5 3.5L5 8l4.5 4.5" />,
  follow: <path d="M8 3v9M4 8.5l4 4 4-4" />,
  hand: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 5v3.5M8 10.6v.1" />
    </>
  ),
  queue: <path d="M3 5h10M3 8h10M3 11h6" />,
} satisfies Record<string, ReactNode>

export type IconName = keyof typeof PATHS

export function Icon({ name, className }: { name: IconName | 'spinner'; className?: string }) {
  if (name === 'spinner') {
    return (
      <svg className={`icon spin ${className ?? ''}`} viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="5.5" opacity="0.25" />
        <path d="M8 2.5a5.5 5.5 0 0 1 5.5 5.5" />
      </svg>
    )
  }
  return (
    <svg className={`icon ${className ?? ''}`} viewBox="0 0 16 16" aria-hidden="true">
      {PATHS[name]}
    </svg>
  )
}
