import { Router, type IRouter } from "express";
import healthRouter from "./health";
import inventoryRouter from "./inventory";
import dictionariesRouter from "./dictionaries";
import aiRouter from "./ai";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/inventory", inventoryRouter);
router.use("/dictionaries", dictionariesRouter);
router.use("/ai", aiRouter);

export default router;
