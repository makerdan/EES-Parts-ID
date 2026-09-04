/**
 * Regression coverage for authoritative inventory data in the expanded
 * PartCard. OP/OQ must remain visible independently of the optional AI lookup
 * and must update when the displayed inventory item changes.
 */

// Required for act() to work correctly in the node test environment.
// @ts-ignore
global.IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import { act, render } from "@testing-library/react-native";
import type { RenderResult } from "@testing-library/react-native";
import type { TestInstance } from "test-renderer";

jest.mock("react-native", () => require("../../__tests__/helpers/mapMocks").createReactNativeMock());
jest.mock("@expo/vector-icons", () => require("../../__tests__/helpers/mapMocks").createVectorIconsMock());
jest.mock("@/hooks/useColors", () => require("../../__tests__/helpers/mapMocks").createUseColorsMock());
jest.mock("@/utils/apiBase", () => ({ API_BASE: "" }));
jest.mock("@/utils/appAuth", () => ({
  __esModule: true,
  fetchWithAuth: jest.fn(),
}));

import { PartCard } from "@/components/PartCard";

const { fetchWithAuth } = require("@/utils/appAuth") as {
  fetchWithAuth: jest.Mock;
};

function findText(root: NonNullable<RenderResult["root"]>, text: string): TestInstance[] {
  return root.queryAll(
    (node) => String(node.type) === "Text" && String(node.props.children) === text,
    { includeSelf: true },
  );
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  fetchWithAuth.mockReset();
});

describe("PartCard — authoritative OP/OQ", () => {
  it("shows OP and OQ, including zero, while the AI lookup is still loading", async () => {
    fetchWithAuth.mockReturnValue(new Promise(() => {}));
    const rendered = await render(
      <PartCard
        catalog="BOLT-001"
        vendor="Acme"
        description="Standard bolt"
        orderPurchase={0}
        orderQuantity={24}
        autoExpand
      />,
    );
    await flushEffects();

    expect(findText(rendered.root!, "OP")).toHaveLength(1);
    expect(findText(rendered.root!, "0")).toHaveLength(1);
    expect(findText(rendered.root!, "OQ")).toHaveLength(1);
    expect(findText(rendered.root!, "24")).toHaveLength(1);

    await rendered.unmount();
  });

  it("keeps OP and OQ visible when the AI lookup fails", async () => {
    fetchWithAuth.mockRejectedValue(new Error("AI unavailable"));
    const rendered = await render(
      <PartCard
        catalog="BOLT-001"
        orderPurchase={7}
        orderQuantity={0}
        autoExpand
      />,
    );
    await flushEffects();

    expect(findText(rendered.root!, "OP")).toHaveLength(1);
    expect(findText(rendered.root!, "7")).toHaveLength(1);
    expect(findText(rendered.root!, "OQ")).toHaveLength(1);
    expect(findText(rendered.root!, "0")).toHaveLength(1);

    await rendered.unmount();
  });

  it("keeps OP and OQ visible when the AI lookup returns no details", async () => {
    fetchWithAuth.mockResolvedValue({
      ok: true,
      json: async () => ({
        displayName: "",
        specs: [],
        crossRefs: [],
        compatibilityNote: "",
      }),
    });
    const rendered = await render(
      <PartCard
        catalog="BOLT-001"
        orderPurchase={5}
        orderQuantity={0}
        autoExpand
      />,
    );
    await flushEffects();

    expect(findText(rendered.root!, "OP")).toHaveLength(1);
    expect(findText(rendered.root!, "5")).toHaveLength(1);
    expect(findText(rendered.root!, "OQ")).toHaveLength(1);
    expect(findText(rendered.root!, "0")).toHaveLength(1);
    expect(findText(rendered.root!, "No additional info found.")).toHaveLength(1);

    await rendered.unmount();
  });

  it("updates OP and OQ when the displayed inventory item changes", async () => {
    fetchWithAuth.mockReturnValue(new Promise(() => {}));
    const rendered = await render(
      <PartCard
        catalog="BOLT-001"
        orderPurchase={3}
        orderQuantity={9}
        autoExpand
      />,
    );
    await flushEffects();

    await rendered.rerender(
      <PartCard
        catalog="BOLT-002"
        orderPurchase={0}
        orderQuantity={16}
        autoExpand
      />,
    );

    expect(findText(rendered.root!, "OP")).toHaveLength(1);
    expect(findText(rendered.root!, "16")).toHaveLength(1);
    expect(findText(rendered.root!, "OQ")).toHaveLength(1);
    expect(findText(rendered.root!, "0")).toHaveLength(1);

    await rendered.unmount();
  });
});