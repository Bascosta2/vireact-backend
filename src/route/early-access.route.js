import { Router } from "express";

import { 
    createEarlyAccess
} from '../controller/early-access.controller.js';

const earlyAccessRoutes = Router();

// Regular auth routes
earlyAccessRoutes.post('/create', createEarlyAccess);


export default earlyAccessRoutes;