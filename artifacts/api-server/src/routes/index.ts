/**
 * Top-level route tree. Each sub-router lives in its own file and is
 * mounted under its REST prefix here. Keeping mounting centralised makes
 * the live URL surface obvious at a glance.
 */
import { Router, type IRouter } from "express";
import healthRouter from "./health";
import inventoryRouter from "./inventory";
import dictionariesRouter from "./dictionaries";
import aiRouter from "./ai";
import referenceRouter from "./reference";
import adminRouter from "./admin";
import adminUploadRouter from "./adminUpload";
import catalogPdfRouter from "./catalogPdf";
import categoriesRouter from "./categories";
import barcodeRouter from "./barcode";
import searchRouter from "./search";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/inventory", inventoryRouter);
router.use("/dictionaries", dictionariesRouter);
router.use("/ai", aiRouter);
router.use("/reference", referenceRouter);
router.use("/admin", adminRouter);
router.use("/admin", adminUploadRouter);
router.use("/admin", catalogPdfRouter);
router.use("/categories", categoriesRouter);
router.use("/barcode", barcodeRouter);
router.use("/search", searchRouter);

export default router;
