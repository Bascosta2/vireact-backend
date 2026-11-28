import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import {
    requireEditorAccess,
    getEditorUsage,
    createEditProject,
    confirmEditUpload,
    listEditProjects,
    listEditSkills,
    getEditProject,
    updateEdits,
    regenerateEdit,
    startEditRender,
    getEditRender,
    scoreEditRender,
    deleteEditProject,
    createStoryboard,
    chooseStoryboard,
    regenerateStoryboards,
    regenerateStoryboardSceneHandler,
} from '../controller/editor.controller.js';

/** Editor tab: AI edits of the creator's own footage. The QStash job webhook is mounted in app.js. */
const editorRoutes = Router();

editorRoutes.use(authenticateToken);

// Usage stays open to every signed-in user: it is how the web app learns the editor is hidden.
editorRoutes.get('/usage', getEditorUsage);
editorRoutes.use(requireEditorAccess);
editorRoutes.get('/skills', listEditSkills);
editorRoutes.get('/projects', listEditProjects);
editorRoutes.post('/projects', createEditProject);
// Story mode: an animated video from a typed idea (three storyboards, the creator picks one).
editorRoutes.post('/storyboards', createStoryboard);
editorRoutes.post('/projects/:id/storyboard/choose', chooseStoryboard);
editorRoutes.post('/projects/:id/storyboard/regenerate', regenerateStoryboards);
editorRoutes.post('/projects/:id/storyboard/scenes/:sceneIdx/regenerate', regenerateStoryboardSceneHandler);
editorRoutes.get('/projects/:id', getEditProject);
editorRoutes.post('/projects/:id/uploaded', confirmEditUpload);
editorRoutes.patch('/projects/:id/edits', updateEdits);
editorRoutes.post('/projects/:id/regenerate', regenerateEdit);
editorRoutes.post('/projects/:id/render', startEditRender);
editorRoutes.get('/projects/:id/render/:renderId', getEditRender);
editorRoutes.post('/projects/:id/score', scoreEditRender);
editorRoutes.delete('/projects/:id', deleteEditProject);

export default editorRoutes;
