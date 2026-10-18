import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@/styles.css";
import { App } from "@/App";
import { initTheme } from "@/lib/theme";
import "../shared/edit-context-menu.browser.js";

initTheme();

const container = document.getElementById("root");
if (!container) throw new Error("root container missing");
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
