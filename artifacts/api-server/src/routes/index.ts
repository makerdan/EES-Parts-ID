import { type IRouter,Router } from "express";

import adminRouter from "./admin";
import adminAiStatusRouter from "./adminAiStatus";
import adminDashboardRouter from "./adminDashboard";
import adminQueryRouter from "./adminQuery";
import adminUploadRouter from "./adminUpload";
import aiRouter from "./ai";
import authRouter from "./auth";
import catalogPdfRouter from "./catalogPdf";
import catalogPdfUploadRouter from "./catalogPdfUpload";
import contactRouter from "./contact";
import dictionariesRouter from "./dictionaries";
import floorPlanRouter from "./floorPlan";
import healthRouter from "./health";
import helpRouter from "./help";
import inventoryRouter from "./inventory";
import inventoryCategoriesRouter from "./inventoryCategories";
import mapAnchorsRouter from "./mapAnchors";
import referenceRouter from "./reference";
import trackRouter from "./track";
import userRouter from "./user";
import warehouseZonesRouter from "./warehouseZones";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/auth", authRouter);
router.use("/inventory", inventoryRouter);
router.use("/inventory", inventoryCategoriesRouter);
router.use("/dictionaries", dictionariesRouter);
router.use("/ai", aiRouter);
router.use("/reference", referenceRouter);
router.use("/help", helpRouter);
router.use("/admin", adminRouter);
router.use("/admin", adminUploadRouter);
router.use("/admin", catalogPdfRouter);
router.use("/admin", catalogPdfUploadRouter);
router.use("/admin", adminQueryRouter);
router.use("/admin", adminDashboardRouter);
router.use("/admin", adminAiStatusRouter);
router.use("/admin", mapAnchorsRouter);
router.use("/warehouse-zones", warehouseZonesRouter);
router.use(floorPlanRouter);
router.use("/user", userRouter);
router.use("/contact", contactRouter);
router.use("/track", trackRouter);

export default router;
