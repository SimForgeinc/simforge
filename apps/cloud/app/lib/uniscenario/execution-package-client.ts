import {
  ExecutionPackageMembersSchema,
  type ExecutionPackageMemberDto,
  type ExecutionPackageMemberRole,
} from "./execution-package-contracts";

export type VerifiedExecutionPackageMember = ExecutionPackageMemberDto & {
  bytes: Uint8Array;
};

export class ExecutionPackageMemberVerificationError extends Error {
  readonly code:
    | "invalid_manifest"
    | "download_failed"
    | "byte_length_mismatch"
    | "sha256_mismatch";
  readonly role: ExecutionPackageMemberRole | null;

  constructor(
    code: ExecutionPackageMemberVerificationError["code"],
    role: ExecutionPackageMemberRole | null,
  ) {
    super(`execution_package_member_${code}${role ? `:${role}` : ""}`);
    this.name = "ExecutionPackageMemberVerificationError";
    this.code = code;
    this.role = role;
  }
}

function parseMembers(value: unknown): readonly ExecutionPackageMemberDto[] {
  const parsed = ExecutionPackageMembersSchema.safeParse(value);
  if (!parsed.success) {
    throw new ExecutionPackageMemberVerificationError("invalid_manifest", null);
  }
  const seen = new Set<ExecutionPackageMemberRole>();
  for (const member of parsed.data.members) {
    if (seen.has(member.role)) {
      throw new ExecutionPackageMemberVerificationError("invalid_manifest", member.role);
    }
    seen.add(member.role);
  }
  return parsed.data.members;
}

async function verifyMember(
  member: ExecutionPackageMemberDto,
  signal?: AbortSignal,
): Promise<VerifiedExecutionPackageMember> {
  const response = await fetch(member.url, { cache: "no-store", signal });
  if (!response.ok) {
    throw new ExecutionPackageMemberVerificationError("download_failed", member.role);
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength !== member.byteLength) {
    throw new ExecutionPackageMemberVerificationError("byte_length_mismatch", member.role);
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", buffer));
  let actualSha256 = "";
  for (const byte of digest) actualSha256 += byte.toString(16).padStart(2, "0");
  if (actualSha256 !== member.sha256) {
    throw new ExecutionPackageMemberVerificationError("sha256_mismatch", member.role);
  }
  return { ...member, bytes: new Uint8Array(buffer) };
}

export async function getExecutionPackageMembersClient(
  executionPackageId: string,
  signal?: AbortSignal,
): Promise<readonly VerifiedExecutionPackageMember[]> {
  const response = await fetch(
    `/api/uniscenario/execution-packages/${encodeURIComponent(executionPackageId)}/members`,
    { cache: "no-store", signal },
  );
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(payload?.error ?? `execution_package_members_request_${response.status}`);
  }
  const members = parseMembers(await response.json());
  return Promise.all(members.map((member) => verifyMember(member, signal)));
}
