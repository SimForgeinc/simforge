import { z } from "zod";

export const EXECUTION_PACKAGE_MEMBER_ROLES = [
  "xosc",
  "execution-manifest",
  "map-xodr",
  "map-topology",
  "map-derived-topology",
  "map-locations",
  "map-signals",
  "asset-catalog",
] as const;

export const ExecutionPackageMemberRoleSchema = z.enum(
  EXECUTION_PACKAGE_MEMBER_ROLES,
);

export const ExecutionPackageMemberSchema = z.strictObject({
  role: ExecutionPackageMemberRoleSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  byteLength: z.number().int().nonnegative().safe(),
  mediaType: z.string().trim().min(1),
  url: z.string().url(),
});

export const ExecutionPackageMembersSchema = z.strictObject({
  members: z.array(ExecutionPackageMemberSchema),
});

export type ExecutionPackageMemberRole = z.infer<
  typeof ExecutionPackageMemberRoleSchema
>;
export type ExecutionPackageMemberDto = z.infer<
  typeof ExecutionPackageMemberSchema
>;
export type ExecutionPackageMembersDto = z.infer<
  typeof ExecutionPackageMembersSchema
>;
