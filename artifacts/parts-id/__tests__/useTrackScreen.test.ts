jest.mock("react", () => ({
  useEffect: (effect: () => void) => effect(),
}));

jest.mock("@/utils/apiBase", () => ({ API_BASE: "https://example.test/api" }));
jest.mock("@/utils/appAuth", () => ({ fetchWithAuth: jest.fn() }));

import { fetchWithAuth } from "@/utils/appAuth";

import { useTrackScreen } from "../utils/useTrackScreen";

const fetchMock = fetchWithAuth as jest.MockedFunction<typeof fetchWithAuth>;

describe("useTrackScreen", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
  });

  it("sends the finite versioned event contract without blocking", () => {
    useTrackScreen("Search");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.test/api/track/screen-view",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ version: 1, event: "screen_view", screen: "Search" }),
      }),
    );
  });

  it("drops malformed local labels and swallows fire-and-forget failures", async () => {
    useTrackScreen("not-a-screen" as never);
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockRejectedValueOnce(new Error("offline"));
    expect(() => useTrackScreen("Map")).not.toThrow();
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});