export type Theme = "light" | "dark" | "system";

/**
 * Apply a theme choice to the document by toggling the `.dark` class,
 * resolving "system" against the OS color-scheme preference, and keeping
 * the native title-bar overlay controls (min/max/close) in sync.
 */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  const isDark =
    theme === "dark" ||
    (theme === "system" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);

  root.classList.toggle("dark", isDark);

  window.electronAPI?.setTitleBarTheme(isDark).catch(() => {
    // main process may not be ready yet during initial boot
  });
}
