/**
 * Regression tests: Reference AI ("Ask the AI") modal failure → retry path.
 *
 * When an AI question or a quick-lookup chip fails (network reject / non-OK
 * response) the modal shows an error bubble with a "↺ Retry" button. That
 * button is the user's ONLY recovery path — if it is unwired, or replays the
 * wrong request, users are stranded on a dead-end error state. This suite
 * locks the recovery contract in place:
 *
 *   1. A typed question driven to failure renders the error bubble + Retry.
 *      Pressing Retry re-issues the SAME question (same request body) and,
 *      on success, clears the error and shows the answer.
 *   2. A chip-tap driven to failure renders the same error bubble + Retry.
 *      Pressing Retry replays the EXACT chip label + full question through
 *      fetchChipAnswer (chip retries go through fetchChipAnswer, never
 *      askQuestion) and, on success, clears the error.
 *
 * Rendering strategy
 * ──────────────────
 * react-test-renderer@19 can silently drop conditional children from toJSON();
 * the instance tree (renderer.root.findAll) is authoritative, so all lookups
 * go through findAll on host tags produced by the react-native Jest mock.
 *
 * fetchWithAuth (typed-question path) and fetchChipAnswer (chip path) are the
 * two network seams. They are mocked directly so failure/success can be driven
 * deterministically without any real network or auth. BoundedLruMap is kept
 * real (the component instantiates one) via requireActual.
 */

(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";

// API_BASE guard throws in Jest (__DEV__=false, no env var) unless stubbed.
jest.mock("@/utils/apiBase", () => ({ API_BASE: "" }));

// ContactSheet drags in AsyncStorage / fetch; stub it to a marker host node.
jest.mock("@/components/ContactSheet", () => ({
  __esModule: true,
  ContactSheet: ({ visible }: { visible: boolean; onClose: () => void }) => {
    const R = require("react");
    return R.createElement("mock-contact-sheet", { visible });
  },
}));

// Typed-question network seam.
jest.mock("@/utils/appAuth", () => ({
  __esModule: true,
  fetchWithAuth: jest.fn(),
}));

// Chip network seam. BoundedLruMap is real (component instantiates one);
// prefetchQuickLookups is a no-op so modal onShow never touches the network.
jest.mock("@/utils/chipCache", () => {
  const actual = jest.requireActual("@/utils/chipCache");
  return {
    __esModule: true,
    BoundedLruMap: actual.BoundedLruMap,
    fetchChipAnswer: jest.fn(),
    prefetchQuickLookups: jest.fn(() => Promise.resolve()),
  };
});

import { ReferenceModal } from "@/components/ReferenceModal";

const { fetchWithAuth } = require("@/utils/appAuth") as {
  fetchWithAuth: jest.Mock;
};
const chipCache = require("@/utils/chipCache") as {
  fetchChipAnswer: jest.Mock;
};

type TestInstance = ReturnType<typeof TestRenderer.create>["root"];

const ERROR_TEXT = "No answer — check your connection and try again.";
const RETRY_TEXT = "↺  Retry";

/** Flush all pending microtasks (awaited promise chains) inside act(). */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Finds host <rn-text> nodes whose (string) child equals `text`. */
function findTextNodes(root: TestInstance, text: string) {
  return root.findAll(
    (node) =>
      String(node.type) === "rn-text" && node.props.children === text,
  );
}

/**
 * Finds the button(s) for a given label by locating the <rn-text> host node
 * with that label and walking up to its NEAREST <rn-pressable> ancestor.
 *
 * A descendant-based Pressable search would also match the outer wrapper
 * Pressable (the double-tap handler around the whole answer bubble); anchoring
 * on the nearest ancestor isolates the actual button (chip / send / retry).
 */
function findPressableWithText(root: TestInstance, text: string) {
  const textNodes = findTextNodes(root, text);
  const buttons: Array<ReturnType<TestInstance["find"]>> = [];
  for (const t of textNodes) {
    let cur = t.parent;
    while (cur && String(cur.type) !== "rn-pressable") cur = cur.parent;
    if (cur) buttons.push(cur);
  }
  return buttons;
}

/** Finds the empty-state text input by its placeholder. */
function findQuestionInput(root: TestInstance) {
  return root.findAll(
    (node) =>
      String(node.type) === "rn-text-input" &&
      node.props.placeholder === "Ask about parts, codes, or the app...",
  );
}

/** Finds the send Pressable(s) (child text "→"). */
function findSendButtons(root: TestInstance) {
  return findPressableWithText(root, "→");
}

beforeEach(() => {
  jest.clearAllMocks();
  chipCache.fetchChipAnswer.mockReset();
});

describe("ReferenceModal — typed question retry", () => {
  const QUESTION = "What gauge wire for a 20A circuit?";

  it("renders the error bubble + Retry on failure, then retries the SAME question and clears the error on success", async () => {
    // First ask() call fails (non-OK response).
    fetchWithAuth.mockResolvedValueOnce({ ok: false });

    let renderer!: ReturnType<typeof TestRenderer.create>;
    await act(async () => {
      renderer = TestRenderer.create(<ReferenceModal open={true} onClose={jest.fn()} />);
    });

    // Type a question into the empty-state input.
    const inputs = findQuestionInput(renderer.root);
    expect(inputs).toHaveLength(1);
    await act(async () => {
      inputs[0].props.onChangeText(QUESTION);
    });

    // Press send → askQuestion() with the typed question.
    const sendButtons = findSendButtons(renderer.root);
    expect(sendButtons).toHaveLength(1);
    await act(async () => {
      sendButtons[0].props.onPress();
    });
    await flush();

    // First request carried the typed question.
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
    const firstBody = JSON.parse(fetchWithAuth.mock.calls[0][1].body);
    expect(firstBody.question).toBe(QUESTION);

    // Error bubble + Retry render.
    expect(findTextNodes(renderer.root, ERROR_TEXT)).toHaveLength(1);
    const retryButtons = findPressableWithText(renderer.root, RETRY_TEXT);
    expect(retryButtons).toHaveLength(1);

    // Retry succeeds this time.
    fetchWithAuth.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ answer: "Use 12 AWG copper." }),
    });

    await act(async () => {
      retryButtons[0].props.onPress();
    });
    await flush();

    // Retry re-issued the SAME question (askQuestion re-invoked with original).
    expect(fetchWithAuth).toHaveBeenCalledTimes(2);
    const retryBody = JSON.parse(fetchWithAuth.mock.calls[1][1].body);
    expect(retryBody.question).toBe(QUESTION);

    // Error cleared; answer now visible in history.
    expect(findTextNodes(renderer.root, ERROR_TEXT)).toHaveLength(0);
    expect(findPressableWithText(renderer.root, RETRY_TEXT)).toHaveLength(0);
    expect(findTextNodes(renderer.root, "Use 12 AWG copper.")).toHaveLength(1);
  });

  it("also recovers when the typed request rejects (network error)", async () => {
    fetchWithAuth.mockRejectedValueOnce(new Error("network down"));

    let renderer!: ReturnType<typeof TestRenderer.create>;
    await act(async () => {
      renderer = TestRenderer.create(<ReferenceModal open={true} onClose={jest.fn()} />);
    });

    const inputs = findQuestionInput(renderer.root);
    await act(async () => {
      inputs[0].props.onChangeText(QUESTION);
    });
    await act(async () => {
      findSendButtons(renderer.root)[0].props.onPress();
    });
    await flush();

    expect(findTextNodes(renderer.root, ERROR_TEXT)).toHaveLength(1);

    fetchWithAuth.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ answer: "Recovered." }),
    });
    await act(async () => {
      findPressableWithText(renderer.root, RETRY_TEXT)[0].props.onPress();
    });
    await flush();

    expect(fetchWithAuth).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchWithAuth.mock.calls[1][1].body).question).toBe(QUESTION);
    expect(findTextNodes(renderer.root, ERROR_TEXT)).toHaveLength(0);
  });
});

describe("ReferenceModal — chip retry", () => {
  const CHIP_LABEL = "GFCI";
  const CHIP_QUESTION =
    "What does GFCI stand for, how does it work, and where is it required by the NEC?";

  it("renders the error bubble + Retry on chip failure, then replays the exact chip label + full question through fetchChipAnswer", async () => {
    // First chip fetch fails.
    chipCache.fetchChipAnswer.mockRejectedValueOnce(new Error("boom"));

    let renderer!: ReturnType<typeof TestRenderer.create>;
    await act(async () => {
      renderer = TestRenderer.create(<ReferenceModal open={true} onClose={jest.fn()} />);
    });

    // Tap the GFCI quick-lookup chip.
    const chipButtons = findPressableWithText(renderer.root, CHIP_LABEL);
    expect(chipButtons).toHaveLength(1);
    await act(async () => {
      chipButtons[0].props.onPress();
    });
    await flush();

    // First chip call used the exact label + full question.
    expect(chipCache.fetchChipAnswer).toHaveBeenCalledTimes(1);
    expect(chipCache.fetchChipAnswer.mock.calls[0][0]).toBe(CHIP_LABEL);
    expect(chipCache.fetchChipAnswer.mock.calls[0][1]).toBe(CHIP_QUESTION);

    // Error bubble + Retry render; the typed-question seam was never touched.
    expect(findTextNodes(renderer.root, ERROR_TEXT)).toHaveLength(1);
    const retryButtons = findPressableWithText(renderer.root, RETRY_TEXT);
    expect(retryButtons).toHaveLength(1);
    expect(fetchWithAuth).not.toHaveBeenCalled();

    // Retry succeeds this time.
    chipCache.fetchChipAnswer.mockResolvedValueOnce("A GFCI protects against ground faults.");
    await act(async () => {
      retryButtons[0].props.onPress();
    });
    await flush();

    // Retry replayed the EXACT chip label + full question via fetchChipAnswer,
    // NOT askQuestion (fetchWithAuth still untouched).
    expect(chipCache.fetchChipAnswer).toHaveBeenCalledTimes(2);
    expect(chipCache.fetchChipAnswer.mock.calls[1][0]).toBe(CHIP_LABEL);
    expect(chipCache.fetchChipAnswer.mock.calls[1][1]).toBe(CHIP_QUESTION);
    expect(fetchWithAuth).not.toHaveBeenCalled();

    // Error cleared; answer visible in history.
    expect(findTextNodes(renderer.root, ERROR_TEXT)).toHaveLength(0);
    expect(findPressableWithText(renderer.root, RETRY_TEXT)).toHaveLength(0);
    expect(findTextNodes(renderer.root, "A GFCI protects against ground faults.")).toHaveLength(1);
  });
});
