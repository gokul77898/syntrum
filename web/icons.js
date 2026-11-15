// Inline 24px stroke icons. No emoji anywhere in the interface.

const S = (d, extra = "") =>
  `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" ` +
  `stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${d}</svg>`;

export const icons = {
  overview: S('<rect x="3" y="3" width="7" height="8" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="3" y="15" width="7" height="6" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/>'),
  computers: S('<rect x="2.5" y="4" width="19" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>'),
  workspace: S('<rect x="2.5" y="4.5" width="19" height="15" rx="2"/><path d="M2.5 9h19"/><path d="M6 6.7h.01M8.6 6.7h.01"/>'),
  agents: S('<circle cx="9" cy="8" r="3"/><path d="M3.5 20a5.8 5.8 0 0 1 11 0"/><path d="M17 6.2a2.6 2.6 0 0 1 0 5M18.2 14.6a4.4 4.4 0 0 1 2.8 4.1"/>'),
  settings: S('<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M4.6 7.8l2 1.2M17.4 15l2 1.2M4.6 16.2l2-1.2M17.4 9l2-1.2"/>'),
  plus: S('<path d="M12 5v14M5 12h14"/>'),
  play: S('<path d="M7 4.8l11 7.2-11 7.2z"/>'),
  stop: S('<rect x="6" y="6" width="12" height="12" rx="1.5"/>'),
  restart: S('<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4v4.6h-4.6"/>'),
  trash: S('<path d="M4 7h16M9 7V5.2A1.2 1.2 0 0 1 10.2 4h3.6A1.2 1.2 0 0 1 15 5.2V7M6 7l1 12.2A1.8 1.8 0 0 0 8.8 21h6.4a1.8 1.8 0 0 0 1.8-1.8L18 7"/>'),
  refresh: S('<path d="M20.5 11a8.5 8.5 0 1 0-.9 5"/><path d="M20.5 4.5V11H14"/>'),
  cpu: S('<rect x="7" y="7" width="10" height="10" rx="1.5"/><path d="M10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4"/>'),
  memory: S('<rect x="3" y="7" width="18" height="10" rx="1.8"/><path d="M7 11v2M12 11v2M17 11v2"/>'),
  disk: S('<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>'),
  info: S('<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.8h.01"/>'),
  alert: S('<path d="M12 3.8 21 20H3z"/><path d="M12 9.5v4.2M12 17h.01"/>'),
  check: S('<path d="M4.5 12.5 9.5 17.5 20 6.5"/>'),
  close: S('<path d="M6 6l12 12M18 6 6 18"/>'),
  external: S('<path d="M14 4h6v6"/><path d="M20 4l-8 8"/><path d="M18 14v4.5A1.5 1.5 0 0 1 16.5 20h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/>'),
  logout: S('<path d="M14 4h4.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H14"/><path d="M9 8l-4 4 4 4M5 12h10"/>'),
  plug: S('<path d="M9 3v6M15 3v6"/><path d="M6 9h12v2.5A6 6 0 0 1 12 17.5 6 6 0 0 1 6 11.5z"/><path d="M12 17.5V21"/>'),
  server: S('<rect x="3" y="4" width="18" height="7" rx="1.6"/><rect x="3" y="13" width="18" height="7" rx="1.6"/><path d="M7 7.5h.01M7 16.5h.01"/>'),
  user: S('<circle cx="12" cy="8" r="3.4"/><path d="M5 20a7 7 0 0 1 14 0"/>'),
  layers: S('<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>')
};

export function icon(name) {
  return icons[name] ?? icons.info;
}
