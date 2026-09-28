const mockDeletedPaths: string[] = [];
const mockSavedPaths: string[] = [];
const mockSaveOptions: unknown[] = [];

jest.mock("@google-cloud/storage", () => ({
  Storage: class {
    bucket() {
      return {
        file(path: string) {
          return {
            save: jest.fn(async (_bytes: Buffer, options: unknown) => {
              mockSavedPaths.push(path);
              mockSaveOptions.push(options);
            }),
            download: jest.fn().mockResolvedValue([Buffer.from("map")]),
            delete: jest.fn(async () => {
              mockDeletedPaths.push(path);
            }),
          };
        },
      };
    }
  },
}));

import {
  deleteFloorPlanSvg,
  deletePrivateObjects,
  isPublicFloorPlanObjectPath,
  isPrivateObjectPath,
  readFloorPlanSvg,
  uploadCatalogImage,
  uploadFloorPlanSvg,
} from "../lib/objectStorage";

beforeEach(() => {
  process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID = "test-bucket";
  process.env.PRIVATE_OBJECT_DIR = "uploads";
  mockDeletedPaths.length = 0;
  mockSavedPaths.length = 0;
  mockSaveOptions.length = 0;
});

afterAll(() => {
  delete process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID;
  delete process.env.PRIVATE_OBJECT_DIR;
});

describe("private object storage policy", () => {
  it("accepts only private namespaces and rejects public map paths", () => {
    expect(isPrivateObjectPath("/objects/uploads/private/catalog-images/opaque.jpg")).toBe(true);
    expect(isPrivateObjectPath("/objects/uploads/catalog-images/legacy.jpg")).toBe(true);
    expect(isPrivateObjectPath("/objects/uploads/private/catalog-pdf-staging/session/0.part")).toBe(true);
    expect(isPrivateObjectPath("/objects/uploads/floor-plan/warehouse-map.svg")).toBe(false);
    expect(isPublicFloorPlanObjectPath("/objects/uploads/public/floor-plan/warehouse-map.svg")).toBe(true);
    expect(isPublicFloorPlanObjectPath("/objects/uploads/private/catalog-images/private.jpg")).toBe(false);
    expect(isPrivateObjectPath("/objects/uploads/private/../floor-plan/warehouse-map.svg")).toBe(false);
    expect(isPrivateObjectPath("https://storage.example/private.jpg")).toBe(false);
  });

  it("writes new catalog images to an opaque private key with no-store metadata", async () => {
    const path = await uploadCatalogImage(Buffer.from("image"), "image/jpeg");
    expect(path).toMatch(/^\/objects\/uploads\/private\/catalog-images\/[0-9a-f-]{36}\.jpg$/);
  });

  it("never selects the public warehouse map for private cleanup", async () => {
    await expect(deletePrivateObjects([
      "/objects/uploads/private/catalog-images/private.jpg",
      "/objects/uploads/floor-plan/warehouse-map.svg",
    ])).rejects.toThrow("private namespace");
    expect(mockDeletedPaths).toEqual(["uploads/private/catalog-images/private.jpg"]);
    await expect(readFloorPlanSvg("/objects/uploads/private/catalog-images/private.jpg"))
      .rejects.toThrow("warehouse floor-plan");
  });

  it("uses distinct floor-plan keys and only deletes new, owned keys idempotently", async () => {
    const first = await uploadFloorPlanSvg("<svg/>");
    const second = await uploadFloorPlanSvg("<svg/>");
    expect(first).not.toBe(second);
    expect(first).toMatch(/^\/objects\/uploads\/public\/floor-plan\/[0-9a-f-]{36}\.svg$/);
    expect(mockSaveOptions[0]).toMatchObject({ preconditionOpts: { ifGenerationMatch: 0 } });
    await readFloorPlanSvg(first);
    await deleteFloorPlanSvg(first);
    await deleteFloorPlanSvg(first);
    expect(mockDeletedPaths).toEqual([first.slice("/objects/".length), first.slice("/objects/".length)]);
    expect(mockSavedPaths).toHaveLength(2);
    await expect(deleteFloorPlanSvg("/objects/uploads/public/floor-plan/warehouse-map.svg"))
      .rejects.toThrow("uniquely owned");
    await expect(deleteFloorPlanSvg("/objects/uploads/private/catalog-images/00000000-0000-4000-8000-000000000000.svg"))
      .rejects.toThrow("uniquely owned");
    expect(mockDeletedPaths).toHaveLength(2);
  });
});