// Theme registry + persistence. Themes are pure CSS token sets declared in
// index.css under [data-theme='…']; switching = one HTML attribute.

export const THEME_KEY = 'ui.theme'

export const THEMES = [
  { id: 'tokyonight-storm', name: 'Tokyo Night Storm', note: 'soft dark · default' },
  { id: 'catppuccin-mocha', name: 'Catppuccin Mocha', note: 'warm dark' },
  { id: 'gruvbox-dark', name: 'Gruvbox Dark', note: 'earthy dark' },
  { id: 'rose-pine-dawn', name: 'Rosé Pine Dawn', note: 'light / paper' },
] as const

export type ThemeId = (typeof THEMES)[number]['id']

const IDS = new Map(THEMES.map((t) => [t.id, t]))

export function getTheme(): ThemeId {
  try {
    const raw = localStorage.getItem(THEME_KEY)
    if (raw && IDS.has(raw as ThemeId)) return raw as ThemeId
  } catch {
    /* private mode */
  }
  return THEMES[0].id
}

export function setTheme(id: ThemeId): void {
  try {
    localStorage.setItem(THEME_KEY, id)
  } catch {
    /* ignore */
  }
  document.documentElement.dataset.theme = id
}
