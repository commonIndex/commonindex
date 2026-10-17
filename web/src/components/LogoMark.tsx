/** The CommonIndex mark: one shared page, a person's line above an agent's
 *  (the square with the spark). Fixed colours, not theme tokens: a logo does
 *  not change with the theme. web/index.html carries the same drawing as the
 *  favicon, and web/public/logo.svg as a file. */
export function LogoMark({ size = 18 }: { size?: number }) {
  return (
    <svg className="logo-mark" width={size} height={size} viewBox="0 0 100 100" aria-hidden="true">
      <rect width="100" height="100" rx="23" fill="#2563eb" />
      <rect x="16" y="20" width="68" height="60" rx="12" fill="#fff" />
      <circle cx="32" cy="38" r="7" fill="#bfd3fb" />
      <path d="M45 38H70" stroke="#2563eb" strokeWidth="5" strokeLinecap="round" />
      <rect x="25" y="55" width="14" height="14" rx="4" fill="#2563eb" />
      <path d="M32 57.4Q33.3 60.7 36.6 62Q33.3 63.3 32 66.6Q30.7 63.3 27.4 62Q30.7 60.7 32 57.4Z" fill="#fff" />
      <path d="M45 62H62" stroke="#2563eb" strokeWidth="5" strokeLinecap="round" />
    </svg>
  )
}
