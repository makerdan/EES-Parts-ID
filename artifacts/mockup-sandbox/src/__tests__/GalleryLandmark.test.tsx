import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

vi.mock("@clerk/react", () => ({
  ClerkProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SignIn: () => null,
  SignUp: () => null,
  useAuth: () => ({ isLoaded: true, isSignedIn: true }),
  useClerk: () => ({ redirectToSignIn: vi.fn(), signOut: vi.fn() }),
}));

vi.mock("../auth/clerkConfig", () => ({
  basePath: "/__mockup",
  clerkAppearance: {},
  clerkLocalization: {},
  clerkProxyUrl: undefined,
  clerkPubKey: "pk_test_gallery",
  stripBase: (path: string) => path,
}));

import App from "../App";

describe("Canvas gallery landmarks", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/__mockup/");
  });

  afterEach(() => {
    cleanup();
  });

  it("renders one main landmark containing the gallery heading, list, and unchanged links", () => {
    render(<App />);

    const mains = screen.getAllByRole("main");
    expect(mains).toHaveLength(1);

    const main = mains[0]!;
    expect(
      within(main).getByRole("heading", { level: 1, name: "Admin Tools" }),
    ).toBeTruthy();

    const list = within(main).getByRole("list");
    const links = within(list).getAllByRole("link");
    expect(links).toHaveLength(3);

    const expectedLinks: Array<[name: string, title: string, destination: string]> = [
      [
        "Zone Editor Draw and manage warehouse zone boundaries on the floor plan. Zones are saved directly to the database. →",
        "Zone Editor",
        "/__mockup/zone-editor",
      ],
      [
        "Warehouse Map Read-only pan/zoom view of the warehouse floor plan SVG. Useful for reviewing the layout without editing zones. →",
        "Warehouse Map",
        "/__mockup/warehouse-map",
      ],
      [
        "Anchor Calibration Place up to 3 named anchor points on the floor plan to align the zone overlay. Anchors are shared with the mobile app's calibration. →",
        "Anchor Calibration",
        "/__mockup/anchor-calibration",
      ],
    ];

    for (const [name, title, destination] of expectedLinks) {
      const link = within(list).getByRole("link", { name });
      expect(link.querySelector("p")?.textContent?.trim()).toBe(title);
      expect(new URL((link as HTMLAnchorElement).href).pathname).toBe(
        destination,
      );
    }
  });
});