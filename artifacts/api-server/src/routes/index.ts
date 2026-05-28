import { Router, type IRouter } from "express";
import healthRouter from "./health";
import inventoryRouter from "./inventory";
import inventoryCategoriesRouter from "./inventoryCategories";
import dictionariesRouter from "./dictionaries";
import aiRouter from "./ai";
import referenceRouter from "./reference";
import adminRouter from "./admin";
import adminUploadRouter from "./adminUpload";
import warehouseZonesRouter from "./warehouseZones";
import catalogPdfRouter from "./catalogPdf";
import floorPlanRouter from "./floorPlan";
import contactRouter from "./contact";
import adminQueryRouter from "./adminQuery";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/inventory", inventoryRouter);
router.use("/inventory", inventoryCategoriesRouter);
router.use("/dictionaries", dictionariesRouter);
router.use("/ai", aiRouter);
router.use("/reference", referenceRouter);
router.use("/admin", adminRouter);
router.use("/admin", adminUploadRouter);
router.use("/admin", catalogPdfRouter);
router.use("/admin", adminQueryRouter);
router.use("/warehouse-zones", warehouseZonesRouter);
router.use(floorPlanRouter);
router.use("/contact", contactRouter);

export default router;
