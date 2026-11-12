// @vitest-environment jsdom
// A page opened with a provider import link (#5420) takes it out of the address bar as App loads, before anything
// else runs (it may hold a key), puts the settings page's Model providers tab there instead, and holds the link in
// memory for Settings to open Add on; opened on the same page (only the fragment changes), it is taken then.
import { describe, expect, it, vi } from "vitest";
vi.hoisted(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false })) as typeof window.matchMedia;
  history.replaceState(null, "", "/s/abc?x=1#import=eyJraW5kIjoiY3VzdG9tIn0&v=1");
});
vi.mock("./lib/store", async (load) => ({ ...(await load<typeof import("./lib/store")>()), connect: () => {}, disconnect: () => {} }));
import { dropImportLink, importLinkHeld } from "./lib/import-link";
import "./App";

describe("a page opened with an import link", () => {
  it("leaves the address bar on Model providers without the link, and holds the link", () => {
    expect(location.pathname + location.search + location.hash).toBe("/settings?tab=models");
    expect(importLinkHeld()).toBe(`${location.origin}/s/abc?x=1#import=eyJraW5kIjoiY3VzdG9tIn0&v=1`);
  });

  it("takes one opened on the same page, where only the fragment changes, and its history entry with it", () => {
    dropImportLink();
    const before = history.length;
    // the browser goes to the same address with a new fragment: a new entry, no load
    history.pushState(null, "", "/settings?tab=models#import=eyJr");
    dispatchEvent(new HashChangeEvent("hashchange"));
    expect(location.pathname + location.search + location.hash).toBe("/settings?tab=models");
    expect(history.length).toBe(before + 1);
    expect(importLinkHeld()).toBe(`${location.origin}/settings?tab=models#import=eyJr`);
    // a fragment of the page's own is left alone
    dropImportLink();
    history.pushState(null, "", "/settings?tab=models#settings-providers");
    dispatchEvent(new HashChangeEvent("hashchange"));
    expect(location.hash).toBe("#settings-providers");
    expect(importLinkHeld()).toBeNull();
  });
});
