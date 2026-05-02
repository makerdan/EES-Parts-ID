import { Router, type IRouter } from "express";
import healthRouter from "./health";
import inventoryRouter from "./inventory";
import dictionariesRouter from "./dictionaries";
import aiRouter from "./ai";
import referenceRouter from "./reference";
import adminRouter from "./admin";
import adminUploadRouter from "./adminUpload";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/inventory", inventoryRouter);
router.use("/dictionaries", dictionariesRouter);
router.use("/ai", aiRouter);
router.use("/reference", referenceRouter);
router.use("/admin", adminRouter);
router.use("/admin", adminUploadRouter);

export default router;
