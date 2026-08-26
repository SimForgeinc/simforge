// Build-time shim: the rc.45 @uniscenarios/editor-core tarball bundles the
// actor renderer, external-model loader and sensor overlay that now live in
// @simforge-oss/viewer. Aliasing '@simforge-oss/viewer' here keeps one inlined copy.
export * from '../viewer/src/actorRenderer';
export * from '../viewer/src/externalModel';
export * from '../viewer/src/sensorOverlay';
