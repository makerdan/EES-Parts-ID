import React, { useRef } from "react";
import { describe, it, expect } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { deriveParity } from "../utils/deriveParity";
import { ZoneForm, type FormState } from "../pages/ZoneEditor";

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
