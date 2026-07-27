import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { initTheme } from "./stores/theme.js";

// Apply the saved theme BEFORE React renders so the first paint already has
// the correct data-theme attribute — prevents a flash of the wrong theme.
initTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
