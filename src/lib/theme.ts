export type Theme = "light" | "dark" | "system";

/**
 * Apply a theme choice to the document by toggling the `.dark` class,
 * resolving "system" against the OS color-scheme preference.
 */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "dark") {
    root.classList.add("dark");
  } else if (theme === "light") {
    root.classList.remove("dark");
  } else {
    if (window.matchMedia("(prefers-color-scheme: dark)").matches) {
      root.classList.add("dark");
    } else {
      root.classList.remove("dark");
    }
  }
}
