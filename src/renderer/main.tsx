import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@/styles.css";
import { App } from "@/App";
import { initTheme } from "@/lib/theme";

initTheme();

const container = document.getElementById("root");
if (!container) throw new Error("root container missing");
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
