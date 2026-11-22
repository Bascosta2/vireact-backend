import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { authenticateToken } from '../middleware/auth.js';
import {
    requireAccountsAccess, getAccounts, connectAccount, connectCallback, syncAccountNow, disconnectAccount, getPosts, setPostLink,
} from '../controller/accounts.controller.js';

/** Accounts tab: the user's connected TikTok / YouTube / Instagram accounts and their posts' real numbers. */
const accountsRoutes = Router();

// The platform sends the browser back here after sign-in. No Vireact session: the one-time state proves it.
const callbackLimit = rateLimit({ windowMs: 10 * 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false });
accountsRoutes.get('/callback/:platform', callbackLimit, connectCallback);

accountsRoutes.use(authenticateToken);
// Open to every signed-in user: it is how the web app learns the tab is hidden.
accountsRoutes.get('/', getAccounts);
accountsRoutes.use(requireAccountsAccess);
accountsRoutes.post('/:platform/connect', connectAccount);
accountsRoutes.get('/posts', getPosts);
accountsRoutes.put('/posts/:postId/link', setPostLink);
accountsRoutes.post('/:id/sync', syncAccountNow);
accountsRoutes.delete('/:id', disconnectAccount);

export default accountsRoutes;
