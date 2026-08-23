declare function __integrationBoundary();
type IntegrationBoundary = ReturnType<typeof __integrationBoundary>;

export const failedSceneLoadProgress: IntegrationBoundary;
export const initialSceneLoadProgress: IntegrationBoundary;
export const sceneLoadProgressFromSnapshot: IntegrationBoundary;
export type SceneLoadProgressTracker = IntegrationBoundary;
