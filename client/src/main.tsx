import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { AuthProvider } from "./lib/auth";
import { BusinessProvider } from "./lib/business";
import { initPwa } from "./lib/pwa";
import { ToastProvider } from "./lib/toast";
import "./styles.css";

initPwa();          // capture beforeinstallprompt early and register the service worker (production builds only)

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <AuthProvider>
          <BusinessProvider>
            <App />
          </BusinessProvider>
        </AuthProvider>
      </ToastProvider>
    </BrowserRouter>
  </StrictMode>,
);
