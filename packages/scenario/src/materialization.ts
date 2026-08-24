/** Browser-safe application boundary for turning a v2 template into a simulation input. */

import type { ScenarioTemplateV2 } from './schema/v2/template.js';
import { validateTemplate, type MapContext, type ValidationReport } from './validate/index.js';

/** A construct an adapter could not preserve exactly. Loss is never informational here. */
export interface SemanticLoss {
  path: string;
  code: string;
  message: string;
}

export interface MaterializationProduct<TInput, TManifest = unknown> {
  input: TInput;
  manifest: TManifest;
  /** Must contain every omitted, substituted, degraded, or flattened construct. */
  semanticLosses: readonly SemanticLoss[];
}

/** Implemented by a browser worker, CLI adapter, or test fixture without UI dependencies. */
export interface TemplateMaterializer<TSite, TDraw, TInput, TManifest = unknown> {
  materialize(request: {
    template: ScenarioTemplateV2;
    site: TSite;
    draw: TDraw;
  }): Promise<MaterializationProduct<TInput, TManifest>> | MaterializationProduct<TInput, TManifest>;
}

export class TemplatePreparationError extends Error {
  constructor(
    readonly code: 'template_invalid' | 'semantic_loss',
    message: string,
    readonly validation: ValidationReport,
    readonly losses: readonly SemanticLoss[] = [],
  ) {
    super(message);
    this.name = 'TemplatePreparationError';
  }
}

/**
 * The sole shared application service for playback/export materialization.
 * It validates first and fails closed when the adapter reports any semantic
 * loss, ensuring unsupported authoring constructs cannot disappear silently.
 */
export async function prepareSimulationInput<TSite, TDraw, TInput, TManifest = unknown>(options: {
  template: ScenarioTemplateV2;
  site: TSite;
  draw: TDraw;
  materializer: TemplateMaterializer<TSite, TDraw, TInput, TManifest>;
  mapContext?: MapContext;
}): Promise<MaterializationProduct<TInput, TManifest>> {
  const validation = validateTemplate(options.template, options.mapContext);
  if (!validation.ok) {
    throw new TemplatePreparationError(
      'template_invalid',
      'template cannot be materialized until validation errors are resolved',
      validation,
    );
  }
  const result = await options.materializer.materialize({
    template: options.template,
    site: options.site,
    draw: options.draw,
  });
  if (result.semanticLosses.length > 0) {
    throw new TemplatePreparationError(
      'semantic_loss',
      `materializer reported ${result.semanticLosses.length} unsupported or degraded construct(s)`,
      validation,
      result.semanticLosses,
    );
  }
  return result;
}
