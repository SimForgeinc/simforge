import { z } from "zod";

export const CompilerDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const ClaimCompilerExportSchema = z.strictObject({
  workerId: z.string().trim().min(1).max(200),
  leaseSeconds: z.number().int().min(30).max(1_800).default(900),
});

export const CompilerFenceSchema = z.strictObject({
  attemptId: z.string().trim().min(1),
  fenceToken: z.string().trim().min(32).max(512),
});

export const HeartbeatCompilerExportSchema = CompilerFenceSchema.extend({
  leaseSeconds: z.number().int().min(30).max(1_800).default(900),
});

export const CompilerOutputKindSchema = z.enum([
  "xosc",
  "capability-report",
  "compiler-provenance",
  "execution-manifest",
]);

export const ReserveCompilerOutputsSchema = CompilerFenceSchema.extend({
  artifacts: z
    .array(
      z.strictObject({
        kind: CompilerOutputKindSchema,
        mediaType: z.enum(["application/xml", "application/json"]),
        sha256: CompilerDigestSchema,
        sizeBytes: z
          .number()
          .int()
          .positive()
          .max(128 * 1024 * 1024),
      }),
    )
    .length(4)
    .superRefine((items, context) => {
      if (new Set(items.map((item) => item.kind)).size !== items.length) {
        context.addIssue({
          code: "custom",
          message: "Compiler output kinds must be unique.",
        });
      }
    }),
});

export const CompleteCompilerExportSchema = CompilerFenceSchema.extend({
  artifacts: z
    .array(
      z.strictObject({
        id: z.string().trim().min(1),
        kind: CompilerOutputKindSchema,
        sha256: CompilerDigestSchema,
        sizeBytes: z
          .number()
          .int()
          .positive()
          .max(128 * 1024 * 1024),
      }),
    )
    .length(4)
    .superRefine((items, context) => {
      if (new Set(items.map((item) => item.kind)).size !== items.length) {
        context.addIssue({
          code: "custom",
          message: "Compiler output kinds must be unique.",
        });
      }
      if (new Set(items.map((item) => item.id)).size !== items.length) {
        context.addIssue({
          code: "custom",
          message: "Compiler output artifact IDs must be unique.",
        });
      }
    }),
  manifestSha256: CompilerDigestSchema,
  xsdSha256: CompilerDigestSchema,
  sourceInputDigest: CompilerDigestSchema,
});

export const FailCompilerExportSchema = CompilerFenceSchema.extend({
  code: z.string().trim().min(1).max(100),
  detail: z.record(z.string(), z.unknown()).default({}),
});
