import React, { useRef } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, waitFor, act } from "@testing-library/react";
import { deriveParity } from "../utils/deriveParity";
import { ZoneEditor, ZoneForm, type FormState } from "../pages/ZoneEditor";

// ── Pure utility tests ─────────────────────────────────────────────────────────

describe("deriveParity — pure label parsing", () => {
  describe("even results", () => {
    it("returns 'even' for label '12'", () => {
      expect(deriveParity("12")).toBe("even");
    });

    it("returns 'even' for label '0'", () => {
      expect(deriveParity("0")).toBe("even");
    });

    it("returns 'even' for label '00' (zero is even)", () => {
      expect(deriveParity("00")).toBe("even");
    });

    it("returns 'even' for '12A' (leading 12 is even)", () => {
      expect(deriveParity("12A")).toBe("even");
    });

    it("returns 'even' for '02B'", () => {
      expect(deriveParity("02B")).toBe("even");
    });

    it("returns 'even' for '100'", () => {
      expect(deriveParity("100")).toBe("even");
    });
  });

  describe("odd results", () => {
    it("returns 'odd' for label '7'", () => {
      expect(deriveParity("7")).toBe("odd");
    });

    it("returns 'odd' for label '1'", () => {
      expect(deriveParity("1")).toBe("odd");
    });

    it("returns 'odd' for label '13'", () => {
      expect(deriveParity("13")).toBe("odd");
    });

    it("returns 'odd' for '7A' (leading 7 is odd)", () => {
      expect(deriveParity("7A")).toBe("odd");
    });

    it("returns 'odd' for '01' (leading 01 → 1 is odd)", () => {
      expect(deriveParity("01")).toBe("odd");
    });

    it("returns 'odd' for '99'", () => {
      expect(deriveParity("99")).toBe("odd");
    });
  });

  describe("null results (no leading digits)", () => {
    it("returns null for empty string", () => {
      expect(deriveParity("")).toBeNull();
    });

    it("returns null for a plain letter like 'A'", () => {
      expect(deriveParity("A")).toBeNull();
    });

    it("returns null for a label starting with a letter like 'A12'", () => {
      expect(deriveParity("A12")).toBeNull();
    });

    it("returns null for a space-prefixed string", () => {
      expect(deriveParity(" 12")).toBeNull();
    });

    it("returns null for a hyphen-prefixed string '-1'", () => {
      expect(deriveParity("-1")).toBeNull();
    });
  });
});

// ── ZoneForm component tests ───────────────────────────────────────────────────

/** Helper — wraps ZoneForm in a stateful container so we can observe changes. */
function Fixture({
  initialForm,
  initialOverride = false,
}: {
  initialForm?: Partial<FormState>;
  initialOverride?: boolean;
}) {
  const [form, setForm] = React.useState<FormState>({
    aisleId: "",
    label: "",
    sectionParity: "all",
    isInventory: true,
    sortOrder: 0,
    ...initialForm,
  });
  const parityOverride = useRef(initialOverride);

  return (
    <div>
      <ZoneForm
        form={form}
        onChange={setForm}
        parityOverride={parityOverride}
      />
      {/* Expose parityOverride flag in the DOM for assertion */}
      <span data-testid="override-flag">{String(parityOverride.current)}</span>
    </div>
  );
}

describe("ZoneForm — Section # auto-derive", () => {
  function getSectionInput(container: HTMLElement): HTMLInputElement {
    // The Section # input has placeholder "e.g. 12A"
    return container.querySelector<HTMLInputElement>(
      'input[placeholder="e.g. 12A"]'
    )!;
  }

  function getParitySelect(container: HTMLElement): HTMLSelectElement {
    return container.querySelector<HTMLSelectElement>("select")!;
  }

  it("auto-sets parity to 'even' when an even number is typed in Section #", () => {
    const { container } = render(<Fixture />);
    fireEvent.change(getSectionInput(container), { target: { value: "12" } });
    expect(getParitySelect(container).value).toBe("even");
  });

  it("auto-sets parity to 'odd' when an odd number is typed in Section #", () => {
    const { container } = render(<Fixture />);
    fireEvent.change(getSectionInput(container), { target: { value: "7" } });
    expect(getParitySelect(container).value).toBe("odd");
  });

  it("treats '00' as even", () => {
    const { container } = render(<Fixture />);
    fireEvent.change(getSectionInput(container), { target: { value: "00" } });
    expect(getParitySelect(container).value).toBe("even");
  });

  it("uses leading numeric portion ('12A' → 12 → even)", () => {
    const { container } = render(<Fixture />);
    fireEvent.change(getSectionInput(container), { target: { value: "12A" } });
    expect(getParitySelect(container).value).toBe("even");
  });

  it("leaves parity unchanged when Section # has no leading digits", () => {
    const { container } = render(
      <Fixture initialForm={{ sectionParity: "odd" }} />
    );
    fireEvent.change(getSectionInput(container), { target: { value: "A" } });
    expect(getParitySelect(container).value).toBe("odd");
  });

  it("leaves parity unchanged when Section # is cleared to empty", () => {
    const { container } = render(
      <Fixture initialForm={{ sectionParity: "even" }} />
    );
    fireEvent.change(getSectionInput(container), { target: { value: "" } });
    expect(getParitySelect(container).value).toBe("even");
  });

  it("updates parity on each Section # change (even → odd → even)", () => {
    const { container } = render(<Fixture />);
    const input = getSectionInput(container);
    const select = getParitySelect(container);

    fireEvent.change(input, { target: { value: "12" } });
    expect(select.value).toBe("even");

    fireEvent.change(input, { target: { value: "13" } });
    expect(select.value).toBe("odd");

    fireEvent.change(input, { target: { value: "14" } });
    expect(select.value).toBe("even");
  });
});

describe("ZoneForm — manual parity override lock", () => {
  function getSectionInput(container: HTMLElement): HTMLInputElement {
    return container.querySelector<HTMLInputElement>(
      'input[placeholder="e.g. 12A"]'
    )!;
  }

  function getParitySelect(container: HTMLElement): HTMLSelectElement {
    return container.querySelector<HTMLSelectElement>("select")!;
  }

  it("manual parity selection locks out auto-derive", () => {
    const { container } = render(<Fixture />);
    const input = getSectionInput(container);
    const select = getParitySelect(container);

    // First auto-derive sets even
    fireEvent.change(input, { target: { value: "12" } });
    expect(select.value).toBe("even");

    // User manually picks odd
    fireEvent.change(select, { target: { value: "odd" } });
    expect(select.value).toBe("odd");

    // Changing Section # no longer overrides the manual choice
    fireEvent.change(input, { target: { value: "12" } });
    expect(select.value).toBe("odd");
  });

  it("manual override persists across multiple Section # edits", () => {
    const { container } = render(<Fixture />);
    const input = getSectionInput(container);
    const select = getParitySelect(container);

    // User manually sets parity before typing anything
    fireEvent.change(select, { target: { value: "even" } });

    // Even though we type odd numbers, parity stays as user chose
    fireEvent.change(input, { target: { value: "7" } });
    expect(select.value).toBe("even");

    fireEvent.change(input, { target: { value: "99" } });
    expect(select.value).toBe("even");

    fireEvent.change(input, { target: { value: "1" } });
    expect(select.value).toBe("even");
  });

  it("manual override to 'all' also locks out auto-derive", () => {
    const { container } = render(<Fixture />);
    const input = getSectionInput(container);
    const select = getParitySelect(container);

    // Auto-derive first
    fireEvent.change(input, { target: { value: "12" } });
    expect(select.value).toBe("even");

    // User explicitly picks "all"
    fireEvent.change(select, { target: { value: "all" } });

    // Now typing a number keeps it at "all"
    fireEvent.change(input, { target: { value: "7" } });
    expect(select.value).toBe("all");
  });

  it("auto-derive is active again when parityOverride starts as false", () => {
    // Simulates a form reset: a fresh ref with initialOverride=false
    const { container } = render(<Fixture initialOverride={false} />);
    const input = getSectionInput(container);

    fireEvent.change(input, { target: { value: "7" } });
    expect(getParitySelect(container).value).toBe("odd");
  });

  it("auto-derive is suppressed when parityOverride starts as true", () => {
    // Simulates a zone that was manually set before this render
    const { container } = render(
      <Fixture
        initialForm={{ sectionParity: "all" }}
        initialOverride={true}
      />
    );
    const input = getSectionInput(container);

    fireEvent.change(input, { target: { value: "12" } });
    // Override already set — parity must stay "all"
    expect(getParitySelect(container).value).toBe("all");
  });
});

// ── ZoneEditor integration — zone-switch resets the override ───────────────────

/** Shared zone shape matching the Zone type in ZoneEditor */
const ZONE_1 = {
  id: 1, aisleId: "1", label: "12", sectionParity: "even",
  isInventory: true, sortOrder: 0,
  svgX: 10, svgY: 10, svgWidth: 100, svgHeight: 100,
};
const ZONE_2 = {
  id: 2, aisleId: "1", label: "7", sectionParity: "odd",
  isInventory: true, sortOrder: 1,
  svgX: 200, svgY: 10, svgWidth: 100, svgHeight: 100,
};

function mockFetchWithZones(zones: typeof ZONE_1[]) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true, status: 200,
    json: () => Promise.resolve({ zones, unsortedCount: 0, uncoveredAisles: [] }),
    text: () => Promise.resolve(""),
  } as unknown as Response);
}

/** Find the sidebar zone-list meta div (unique: "Aisle N · parity") */
function findZoneListItem(container: HTMLElement, metaText: string): HTMLElement {
  const el = Array.from(container.querySelectorAll("div")).find(
    (d) => d.children.length === 0 && d.textContent === metaText,
  );
  if (!el) throw new Error(`Zone list item "${metaText}" not found`);
  return el as HTMLElement;
}

function getSectionInput(container: HTMLElement) {
  return container.querySelector<HTMLInputElement>('input[placeholder="e.g. 12A"]')!;
}
function getParitySelect(container: HTMLElement) {
  return container.querySelector<HTMLSelectElement>("select")!;
}

describe("ZoneEditor integration — zone switch resets parity override", () => {
  beforeEach(() => {
    mockFetchWithZones([ZONE_1, ZONE_2]);
  });

  it("switching to a different zone re-enables auto-derive", async () => {
    const { container } = render(<ZoneEditor />);

    // Wait for zone 1 to appear in the sidebar list
    await waitFor(() => {
      findZoneListItem(container, "Aisle 1 · even");
    });

    // Click zone 1 → form populates with zone 1 data
    await act(async () => {
      fireEvent.click(findZoneListItem(container, "Aisle 1 · even"));
    });
    const sectionInput = await waitFor(() => {
      const el = getSectionInput(container);
      if (!el) throw new Error("form not visible");
      return el;
    });
    const paritySelect = getParitySelect(container);

    // Manually set parity — this should lock the override
    fireEvent.change(paritySelect, { target: { value: "odd" } });

    // Confirm override is locked: typing an even number doesn't flip parity
    fireEvent.change(sectionInput, { target: { value: "14" } });
    expect(paritySelect.value).toBe("odd");

    // Click zone 2 — different id → prevSelectedIdRef check resets override
    await act(async () => {
      fireEvent.click(findZoneListItem(container, "Aisle 1 · odd"));
    });

    // Wait for form to reload with zone 2's data (label "7")
    await waitFor(() => {
      expect(sectionInput.value).toBe("7");
    });

    // Auto-derive is now active: typing an even number → parity becomes "even"
    fireEvent.change(sectionInput, { target: { value: "12" } });
    expect(paritySelect.value).toBe("even");
  });

  it("clicking the same zone again does NOT reset the override", async () => {
    const { container } = render(<ZoneEditor />);

    await waitFor(() => { findZoneListItem(container, "Aisle 1 · even"); });

    // Select zone 1
    await act(async () => {
      fireEvent.click(findZoneListItem(container, "Aisle 1 · even"));
    });
    const sectionInput = await waitFor(() => {
      const el = getSectionInput(container);
      if (!el) throw new Error("form not visible");
      return el;
    });
    const paritySelect = getParitySelect(container);

    // Manually lock override
    fireEvent.change(paritySelect, { target: { value: "odd" } });
    fireEvent.change(sectionInput, { target: { value: "14" } });
    expect(paritySelect.value).toBe("odd");

    // Click the SAME zone again — selectedId doesn't change, so override stays
    await act(async () => {
      fireEvent.click(findZoneListItem(container, "Aisle 1 · even"));
    });

    // Override must still be locked (parity stays "odd" despite even label)
    fireEvent.change(sectionInput, { target: { value: "14" } });
    expect(paritySelect.value).toBe("odd");
  });
});

describe("ZoneEditor integration — drawing a new zone resets parity override", () => {
  beforeEach(() => {
    mockFetchWithZones([ZONE_1]);
  });

  it("drawing a new zone re-enables auto-derive after a manual override", async () => {
    const { container } = render(<ZoneEditor />);

    // Wait for zone list to load
    await waitFor(() => { findZoneListItem(container, "Aisle 1 · even"); });

    // Select zone 1
    await act(async () => {
      fireEvent.click(findZoneListItem(container, "Aisle 1 · even"));
    });
    const sectionInput = await waitFor(() => {
      const el = getSectionInput(container);
      if (!el) throw new Error("form not visible");
      return el;
    });
    const paritySelect = getParitySelect(container);

    // Manually lock the override
    fireEvent.change(paritySelect, { target: { value: "odd" } });
    fireEvent.change(sectionInput, { target: { value: "14" } });
    expect(paritySelect.value).toBe("odd");

    // Switch to Draw mode
    const drawBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Draw Zone"),
    );
    expect(drawBtn).toBeTruthy();
    fireEvent.click(drawBtn!);

    // Simulate a draw gesture: mousedown on SVG → mousemove on document → mouseup
    // In jsdom, getBoundingClientRect() returns zeros and initial tf={x:0,y:0,s:1},
    // so clientX/Y map directly to SVG coordinates — 190×190 >> MIN_ZONE_PX (8).
    const svg = container.querySelector("svg")!;
    await act(async () => {
      fireEvent.mouseDown(svg, { button: 0, clientX: 10, clientY: 10 });
      fireEvent.mouseMove(document, { clientX: 200, clientY: 200 });
      fireEvent.mouseUp(document, { clientX: 200, clientY: 200 });
    });

    // Wait for the "New Zone" form to appear (label input is empty, parity "all")
    await waitFor(() => {
      expect(sectionInput.value).toBe("");
    });

    // Override was reset by the draw completion — auto-derive is active again
    fireEvent.change(sectionInput, { target: { value: "12" } });
    expect(paritySelect.value).toBe("even");
  });
});
