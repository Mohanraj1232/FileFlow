import React from "react";
import ReactDOM from "react-dom/client";
import { HashRouter } from "react-router-dom";
import App from "./App";
import { applyTheme, type Theme } from "./lib/theme";
import "./index.css";

// Apply the persisted theme before first paint so a saved dark/light
// preference doesn't flash the wrong theme while settings load.
window.electronAPI
  .getSettings()
  .then((settings) => applyTheme((settings.theme as Theme) ?? "system"))
  .catch(() => {
    // no persisted settings yet — leave the default (light) theme
  });

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </React.StrictMode>,
);
