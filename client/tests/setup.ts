import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";

// jsdom has no Blob URLs or navigation: record "downloads" instead so tests can assert on them.
declare global { interface Window { __downloads: { name: string; type: string }[] } }
beforeEach(() => {
  window.__downloads = [];
  URL.createObjectURL = vi.fn((b: Blob) => { (window as any).__lastBlob = b; return "blob:test"; }) as any; URL.revokeObjectURL = vi.fn();
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) { if (this.download) window.__downloads.push({ name: this.download, type: ((window as any).__lastBlob as Blob | undefined)?.type ?? "" }); };
});
afterEach(() => { cleanup(); localStorage.clear(); document.body.style.overflow = ""; });
