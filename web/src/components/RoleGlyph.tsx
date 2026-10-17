import type { DesignElement } from '../data/gateway'

/** A 14px mark per role, so the toolbar can be scanned rather than read.
 *
 *  Drawn rather than pulled from an icon set: these are the fifteen roles this
 *  product has, and a generic icon pack would give us a shopping cart and a
 *  cloud for things that are a tab bar and a field label. Each one is the shape
 *  the renderer actually draws — a heading is a heavy bar over a light one, a
 *  tabbar is three stops along a floor. */
export function RoleGlyph({ role }: { role: DesignElement['role'] }) {
  const line = (x: number, y: number, w: number, h = 1.6, o = 1) =>
    <rect key={`${x}-${y}-${w}`} x={x} y={y} width={w} height={h} rx={h / 2} opacity={o} />

  const shape = () => {
    switch (role) {
      case 'heading': return <>{line(1, 3.5, 12, 2.6)}{line(1, 8.5, 8)}</>
      case 'body': return <>{line(1, 3, 12)}{line(1, 6.5, 12)}{line(1, 10, 7)}</>
      case 'field-label': return <>{line(1, 4, 6, 1.4)}{line(1, 7.5, 12, 2.4, 0.35)}</>
      case 'button': return <rect x="1" y="4" width="12" height="6.5" rx="2" />
      case 'input': return <>
        <rect x="1" y="4" width="12" height="6.5" rx="1.6" fill="none"
              stroke="currentColor" strokeWidth="1.2" />
        {line(3, 6.6, 4, 1.4, 0.5)}</>
      case 'image': return <>
        <rect x="1" y="2.5" width="12" height="9.5" rx="1.6" fill="none"
              stroke="currentColor" strokeWidth="1.2" />
        <path d="M2.6 11 6 7.4l2.2 2.4 1.6-1.6 1.8 2.8z" />
        <circle cx="5" cy="5.4" r="1.1" /></>
      case 'list': return <>
        <circle cx="2.6" cy="4" r="1.2" />{line(5.4, 3.3, 7.6)}
        <circle cx="2.6" cy="8.6" r="1.2" />{line(5.4, 7.9, 7.6)}
        <circle cx="2.6" cy="12" r="0" />{line(5.4, 11.4, 5, 1.6, 0.45)}</>
      case 'nav': return <>
        <rect x="1" y="2.5" width="12" height="4" rx="1.2" opacity="0.9" />
        {line(1, 8.5, 12, 1.2, 0.3)}</>
      case 'tabbar': return <>
        {line(1, 10.5, 12, 1.2, 0.3)}
        <circle cx="3.2" cy="6.4" r="1.4" /><circle cx="7" cy="6.4" r="1.4" opacity="0.45" />
        <circle cx="10.8" cy="6.4" r="1.4" opacity="0.45" /></>
      case 'card': return <rect x="1" y="2.5" width="12" height="9.5" rx="2"
                               fill="none" stroke="currentColor" strokeWidth="1.3" />
      case 'divider': return line(1, 6.6, 12, 1.4)
      case 'logo': return <>
        <rect x="1" y="4" width="6" height="6" rx="1.8" />{line(8.4, 6.3, 4.6, 1.4, 0.45)}</>
      case 'avatar': return <>
        <circle cx="7" cy="5.2" r="2.6" />
        <path d="M2.2 12.4a4.8 4.8 0 0 1 9.6 0z" /></>
      case 'badge': return <rect x="1" y="4.6" width="12" height="5.2" rx="2.6" opacity="0.85" />
      case 'icon': return <rect x="2.5" y="2.5" width="9" height="9" rx="2.4" />
      default: return <rect x="1" y="2.5" width="12" height="9.5" rx="2" />
    }
  }

  return (
    <svg viewBox="0 0 14 14" width="14" height="14" fill="currentColor" aria-hidden="true">
      {shape()}
    </svg>
  )
}
