/**
 * Regression tests: Reference AI ("Ask the AI") modal exit path.
 *
 * The modal is a full-screen page-sheet whose ONLY obvious way out is the
 * "← Back" button in the header (it replaced the old "✕" icon). A regression
 * that unwires that button would trap users on the screen with no escape, so
 * this suite locks the exit contract in place:
 *
 *   1. Pressing "← Back" invokes the onClose handler (controlled mode) — the
 *      dismiss path the parent Search screen relies on to return the user.
 *   2. The other header controls still behave as before:
 *        • Contact renders and, when pressed, opens the ContactSheet.
 *        • Clear is absent until there is chat history (unchanged conditional).
 *
 * Rendering strategy
 * ──────────────────
 * react-test-renderer@19 can silently drop conditional children from toJSON();
 * the instance tree (renderer.root.findAll) is authoritative, so all lookups
 * go through findAll on host tags produced by the react-native Jest mock.
 * ContactSheet is mocked to a marker host node so its visibility is trivially
 * observable without pulling in AsyncStorage / network code.
 */

(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";

// ContactSheet is mocked to a marker so we can observe its `visible` prop
// without dragging in AsyncStorage / fetch. It also exposes onClose for
// completeness, though this suite only asserts it opens.
// Without this mock the apiBase guard throws in Jest (__DEV__=false, no env var).
jest.mock("@/utils/apiBase", () => ({ API_BASE: "" }));

jest.mock("@/components/ContactSheet", () => ({
  __esModule: true,
  ContactSheet: ({ visible }: { visible: boolean; onClose: () => void }) => {
    const R = require("react");
    return R.createElement("mock-contact-sheet", { visible });
  },
}));

import { ReferenceModal } from "@/components/ReferenceModal";

type TestInstance = ReturnType<typeof TestRenderer.create>["root"];

/**
 * Finds the host Pressable(s) carrying the given accessibilityLabel.
 * Restricted to the host tag: the react-native mock is a function component
 * that forwards props to a host element, so an unfiltered search would match
 * both the composite and host node for a single Pressable.
 */
function findByAccessibilityLabel(root: TestInstance, label: string) {
  return root.findAll(
    (node) =>
      String(node.type) === "rn-pressable" &&
      node.props != null &&
      node.props.accessibilityLabel === label,
  );
}

/** Finds host <rn-text> nodes whose (string) child equals `text`. */
function findTextNodes(root: TestInstance, text: string) {
  return root.findAll(
    (node) =>
      String(node.type) === "rn-text" && node.props.children === text,
  );
}

/** Finds the Pressable that renders a child <rn-text> with the given label. */
function findPressableWithText(root: TestInstance, text: string) {
  return root.findAll((node) => {
    if (String(node.type) !== "rn-pressable") {
      return false;
    }
    return (
      node.findAll(
        (child) =>
          String(child.type) === "rn-text" &&
          child.props.children === text,
      ).length > 0
    );
  });
}

describe("ReferenceModal — Back button exit path", () => {
  it("invokes onClose when the Back button is pressed", () => {
    const onClose = jest.fn();
    let renderer!: ReturnType<typeof TestRenderer.create>;

    act(() => {
      renderer = TestRenderer.create(
        <ReferenceModal open={true} onClose={onClose} />,
      );
    });

    const backButtons = findByAccessibilityLabel(renderer.root, "Back");
    expect(backButtons).toHaveLength(1);
    expect(backButtons[0].props.accessibilityRole).toBe("button");

    act(() => {
      backButtons[0].props.onPress();
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders the Contact control and opens the ContactSheet when pressed", () => {
    let renderer!: ReturnType<typeof TestRenderer.create>;

    act(() => {
      renderer = TestRenderer.create(
        <ReferenceModal open={true} onClose={jest.fn()} />,
      );
    });

    // ContactSheet starts hidden.
    const sheetBefore = renderer.root.findAllByType("mock-contact-sheet" as never);
    expect(sheetBefore).toHaveLength(1);
    expect(sheetBefore[0].props.visible).toBe(false);

    const contactButtons = findPressableWithText(renderer.root, "Contact");
    expect(contactButtons).toHaveLength(1);

    act(() => {
      contactButtons[0].props.onPress();
    });

    const sheetAfter = renderer.root.findAllByType("mock-contact-sheet" as never);
    expect(sheetAfter[0].props.visible).toBe(true);
  });

  it("hides the Clear control until there is chat history", () => {
    let renderer!: ReturnType<typeof TestRenderer.create>;

    act(() => {
      renderer = TestRenderer.create(
        <ReferenceModal open={true} onClose={jest.fn()} />,
      );
    });

    // No history on a fresh open → Clear is not rendered, matching prior UX.
    expect(findTextNodes(renderer.root, "Clear")).toHaveLength(0);

    // Back and Contact remain the available exit / support controls.
    expect(findByAccessibilityLabel(renderer.root, "Back")).toHaveLength(1);
    expect(findPressableWithText(renderer.root, "Contact")).toHaveLength(1);
  });
});
