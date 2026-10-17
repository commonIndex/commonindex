/** Stroke icons for the doc editor, drawn on a 16-unit grid at 1.4 weight so
 *  they sit with the product's 13px type rather than shouting over it. */
const PATHS = {
  text: 'M3 4h10M8 4v9',
  h1: 'M2.5 3.5v9M8.5 3.5v9M2.5 8h6M11.5 7.5l1.5-1v6',
  h2: 'M2 3.5v9M7.5 3.5v9M2 8h5.5M10.5 7.2c.3-.8 1-1.2 1.8-1.2 1 0 1.7.7 1.7 1.5 0 1.6-3.5 2.6-3.5 5h3.6',
  h3: 'M2 3.5v9M7.5 3.5v9M2 8h5.5M10.6 6.3h3.2l-1.8 2.1c1.1 0 2 .6 2 1.7 0 1.1-.9 1.9-2 1.9-.8 0-1.4-.3-1.7-.9',
  list: 'M6 4h8M6 8h8M6 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01',
  numbered: 'M7 4h7M7 8h7M7 12h7M2.5 3l1-.5v3M2.3 7.3c.2-.4.6-.6 1-.6.5 0 .9.3.9.8 0 .8-1.9 1.3-1.9 2.5h2M2.4 11.2h1.8l-.9 1c.6 0 1 .3 1 .8s-.4.9-1 .9c-.4 0-.7-.1-.9-.4',
  checklist: 'M2 4.2l1.1 1.1L5.2 3.2M2 10.2l1.1 1.1 2.1-2.1M7.5 4.5H14M7.5 10.5H14',
  code: 'M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5M9 3l-2 10',
  calendar: 'M3 4.5h10v8.5H3zM3 7.5h10M5.5 3v3M10.5 3v3',
  divider: 'M3 8h10',
  diagram: 'M1.5 5.5h5v5h-5zM9.5 5.5h5v5h-5zM6.5 8h3M8 6.8 9.5 8 8 9.2',
  artifact: 'M2 3.5h12v9H2zM2 6h12M5.5 8.2 4 9.5l1.5 1.3M10.5 8.2 12 9.5l-1.5 1.3',
  dropdown: 'M2.5 3.5h11v9h-11zM6 7l2 2 2-2',
  quote: 'M3 4v8M6.5 5.5h6.5M6.5 8h6.5M6.5 10.5h4',
  table: 'M2.5 3.5h11v9h-11zM2.5 6.5h11M2.5 9.5h11M6.2 3.5v9M9.8 3.5v9',
  image: 'M2.5 3.5h11v9h-11zM2.5 10.5l3-3 2.5 2.5 2-2 3 3M10.3 6.3h.01',
  link: 'M6.8 9.2a2.6 2.6 0 0 0 3.7 0l2-2a2.6 2.6 0 0 0-3.7-3.7l-.7.7M9.2 6.8a2.6 2.6 0 0 0-3.7 0l-2 2a2.6 2.6 0 0 0 3.7 3.7l.7-.7',
  bold: 'M4.5 3h4a2.5 2.5 0 0 1 0 5h-4zM4.5 8h4.7a2.5 2.5 0 0 1 0 5H4.5z',
  italic: 'M6.5 3H12M4 13h5.5M9.3 3 6.7 13',
  underline: 'M4.5 3v4.5a3.5 3.5 0 0 0 7 0V3M3.5 13.5h9',
  strike: 'M3 8h10M10.8 5.2c-.4-1.3-1.5-2-2.9-2-1.7 0-2.9.9-2.9 2.2 0 .9.5 1.6 1.6 2M5 10.8c.4 1.3 1.6 2 3.1 2 1.8 0 3-.9 3-2.3 0-.5-.1-.9-.4-1.3',
  inlineCode: 'M6 4.5 2.5 8 6 11.5M10 4.5 13.5 8 10 11.5',
  undo: 'M5.5 3.5 2.5 6.5l3 3M2.5 6.5H10a3.5 3.5 0 0 1 0 7H7',
  redo: 'M10.5 3.5l3 3-3 3M13.5 6.5H6a3.5 3.5 0 0 0 0 7h3',
  plus: 'M8 3v10M3 8h10',
  chevron: 'M4.5 6.5 8 10l3.5-3.5',
  send: 'M8 13V3.5M4 7.5l4-4 4 4',
  stop: 'M5 5h6v6H5z',
  sparkle: 'M8 2.5l1.3 3.2 3.2 1.3-3.2 1.3L8 11.5 6.7 8.3 3.5 7l3.2-1.3zM12.5 11l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z',
  history: 'M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 3v2.5H5M8 5v3.2l2 1.3',
  rowAdd: 'M2.5 3.5h11v5h-11zM8 10.5v4M6 12.5h4',
  colAdd: 'M2.5 2.5h5v11h-5zM10.5 8h4M12.5 6v4',
  trash: 'M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5',
  close: 'M4 4l8 8M12 4l-8 8',
} as const

export type IconName = keyof typeof PATHS

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  )
}
