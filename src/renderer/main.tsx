import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@/styles.css";
import { App } from "@/App";
import { TrayMenu } from "@/features/shell/TrayMenu";
import { StartupRecovery } from "@/features/shell/StartupRecovery";
import { initTheme } from "@/lib/theme";
import "../shared/edit-context-menu.browser.js";

initTheme();

const container = document.getElementById("root");
if (!container) throw new Error("root container missing");
createRoot(container).render(
  <StrictMode>
    {document.documentElement.dataset.surface === 'tray' ? <TrayMenu /> : document.documentElement.dataset.surface === 'recovery' ? <StartupRecovery /> : <App />}
  </StrictMode>,
);
