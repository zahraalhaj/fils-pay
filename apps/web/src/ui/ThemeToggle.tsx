import { useState } from "react";

export type Theme = "night" | "light";
const STORAGE_KEY = "fp-theme";

/** The theme index.html applied before first paint ("night" by default). */
export function currentTheme(): Theme {
  return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "night";
}

export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute("data-theme", theme);
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Storage blocked (private mode etc.): the switch still works for this page.
  }
}

/** A single labelled button that switches between the Night and Light
 *  themes. Display preference only — nothing is sent to the server. */
export function ThemeToggle({ className = "dash-button" }: { className?: string }) {
  const [theme, setTheme] = useState<Theme>(currentTheme);
  const next: Theme = theme === "night" ? "light" : "night";
  return (
    <button
      type="button"
      className={className}
      onClick={() => {
        applyTheme(next);
        setTheme(next);
      }}
    >
      <span aria-hidden="true">{theme === "night" ? "☀" : "☾"}</span>
      {next === "light" ? "Switch to light theme" : "Switch to night theme"}
    </button>
  );
}
