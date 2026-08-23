import { z } from "zod";

import { DatasetExportSourceFilterSchema } from "./dataset";

export const DatasetExportScopeSchema = DatasetExportSourceFilterSchema.extend({
  pipelineRunId: z.string().min(1).optional(),
  pipelineRunItemId: z.string().min(1).optional(),
  stageId: z.string().min(1).optional(),
}).strict();
export type DatasetExportScope = z.infer<typeof DatasetExportScopeSchema>;
