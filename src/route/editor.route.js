import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { authenticateToken } from '../middleware/auth.js';
import {
    requireEditorAccess,
    getEditorUsage,
    createEditProject,
    confirmEditUpload,
    listEditProjects,
    listEditSkills,
    getBrand,
    saveBrand,
    getEditProject,
    updateEdits,
    regenerateEdit,
    swapStoryboardBeat,
    startEditRender,
    getEditRender,
    scoreEditRender,
    deleteEditProject,
    attachScreenRecording,
    confirmScreenRecording,
    detachScreenRecording,
} from '../controller/editor.controller.js';

/** Editor tab: AI edits of the creator's own footage. The QStash job webhook is mounted in app.js. */
const editorRoutes = Router();

/** Each swap is a paid planner call: 10 a minute per signed-in user (in-memory, like the other limits). */
const swapRateLimit = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    keyGenerator: (req) => String(req.user?._id ?? 'anon'),
    validate: false,
    message: { error: 'Too many swaps, try again in a minute' },
});

editorRoutes.use(authenticateToken);

// Usage stays open to every signed-in user: it is how the web app learns the editor is hidden.
editorRoutes.get('/usage', getEditorUsage);
editorRoutes.use(requireEditorAccess);
editorRoutes.get('/skills', listEditSkills);
editorRoutes.get('/brand', getBrand);
editorRoutes.put('/brand', saveBrand);
editorRoutes.get('/projects', listEditProjects);
editorRoutes.post('/projects', createEditProject);
editorRoutes.get('/projects/:id', getEditProject);
editorRoutes.post('/projects/:id/uploaded', confirmEditUpload);
editorRoutes.patch('/projects/:id/edits', updateEdits);
editorRoutes.post('/projects/:id/regenerate', regenerateEdit);
editorRoutes.post('/projects/:id/storyboard/swap', swapRateLimit, swapStoryboardBeat);
editorRoutes.post('/projects/:id/screen-recording', attachScreenRecording);
editorRoutes.post('/projects/:id/screen-recording/uploaded', confirmScreenRecording);
editorRoutes.delete('/projects/:id/screen-recording', detachScreenRecording);
editorRoutes.post('/projects/:id/render', startEditRender);
editorRoutes.get('/projects/:id/render/:renderId', getEditRender);
editorRoutes.post('/projects/:id/score', scoreEditRender);
editorRoutes.delete('/projects/:id', deleteEditProject);

export default editorRoutes;
