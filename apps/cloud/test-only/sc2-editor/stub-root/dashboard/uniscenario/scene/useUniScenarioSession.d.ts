declare function __integrationBoundary();
type IntegrationBoundary = ReturnType<typeof __integrationBoundary>;

export type UniScenarioSharedPlayback = IntegrationBoundary;
