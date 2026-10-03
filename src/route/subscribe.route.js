import { Router } from "express";
import { subscribe } from "../controller/subscribe.controller.js";

const subscribeRoutes = Router();

subscribeRoutes.post('/', subscribe);

export default subscribeRoutes;
