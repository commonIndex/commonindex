/** Line icons for the sidebar — one stroke weight, drawn on a 20px grid so
 *  they sit on the text baseline at 16px. Kept here rather than pulled from a
 *  library: the sidebar needs a dozen, and they should look like one set. */
const PATHS: Record<string, React.ReactNode> = {
  code: <path d="M7 6 3 10l4 4M13 6l4 4-4 4" />,
  projects: <><path d="M3 6.5a1.5 1.5 0 0 1 1.5-1.5h3.2l1.6 1.8h6.2A1.5 1.5 0 0 1 17 8.3v6.7a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 15z" /><path d="M7 11.5h6" /></>,
  board: <><rect x="3" y="3.5" width="14" height="13" rx="2" /><path d="M8 3.5v13M12.5 3.5v7" /></>,
  experiments: <><path d="M7.5 3h5M8.5 3v5.2L4.2 15.4A1 1 0 0 0 5 17h10a1 1 0 0 0 .8-1.6L11.5 8.2V3" /><path d="M6.2 12.5h7.6" /></>,
  docs: <><path d="M5.5 2.5H11l4 4v10a1 1 0 0 1-1 1H5.5a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1z" /><path d="M11 2.5v4h4M7.5 10.5h5M7.5 13.5h3.5" /></>,
  dashboards: <><rect x="3" y="3" width="6" height="8" rx="1.3" /><rect x="11" y="3" width="6" height="5" rx="1.3" /><rect x="11" y="10" width="6" height="7" rx="1.3" /><rect x="3" y="13" width="6" height="4" rx="1.3" /></>,
  designs: <><circle cx="7.2" cy="7.2" r="3.7" /><rect x="10" y="10" width="7" height="7" rx="1.3" /></>,
  videos: <><rect x="2.5" y="4.5" width="15" height="11" rx="2" /><path d="M8.5 7.8v4.4l3.8-2.2z" /></>,
  skills: <path d="M11 2.5 4.5 11h5l-1 6.5 6.5-8.5h-5z" />,
  agents: <><rect x="3.5" y="6.5" width="13" height="10" rx="2.5" /><path d="M10 3.5v3" /><circle cx="7.6" cy="11.5" r=".6" fill="currentColor" /><circle cx="12.4" cy="11.5" r=".6" fill="currentColor" /></>,
  channel: <path d="M4 7.5h13M3 12.5h13M8.5 3 7 17M13 3l-1.5 14" />,
  'channel-private': <><rect x="4.5" y="9" width="11" height="8" rx="2" /><path d="M7 9V6.5a3 3 0 0 1 6 0V9" /></>,
  more: <><circle cx="5" cy="10" r=".9" fill="currentColor" /><circle cx="10" cy="10" r=".9" fill="currentColor" /><circle cx="15" cy="10" r=".9" fill="currentColor" /></>,
  chevron: <path d="m7.5 5 5 5-5 5" />,
  signin: <><circle cx="7" cy="12.5" r="3.5" /><path d="M9.5 10 16 3.5M13.5 6l2 2M11.5 8l1.5 1.5" /></>,
  members: <><circle cx="8" cy="7" r="3" /><path d="M2.5 16.5a5.5 5.5 0 0 1 11 0M13 4.3a3 3 0 0 1 0 5.4M14.8 12a5.5 5.5 0 0 1 2.7 4.5" /></>,
}

export function NavIcon({ name }: { name: keyof typeof PATHS | string }) {
  return (
    <svg className="nav-icon" viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor"
      strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name]}
    </svg>
  )
}
