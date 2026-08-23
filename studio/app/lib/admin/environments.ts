import type { AdminEnvironment } from "@/app/lib/auth/capabilities";
import { createHash } from "node:crypto";

export type AdminDeploymentIdentity = {
  environment: AdminEnvironment;
  deploymentReadOnly: boolean;
  projectId: string;
  anchorFingerprint: string;
  ignoredEnvParam: boolean;
};

export type AdminDeploymentIdentityResult =
  | { ok: true; identity: AdminDeploymentIdentity }
  | { ok: false; code: "invalid_admin_deployment_identity"; message: string };

const DEPLOYMENT_CATALOG: Record<
  AdminEnvironment,
  {
    projectId: string;
    awsRoleArn: string;
    auroraClusterArn: string;
    auroraSecretPrefix: string;
  }
> = {
  dev: {
    projectId: "prj_b9jGhL6JnSMWbU4WAPklCAi1InbQ",
    awsRoleArn: "arn:aws:iam::435362779479:role/simcloud-vercel-platform-dev",
    auroraClusterArn: "arn:aws:rds:us-east-1:435362779479:cluster:simcloud-aurora",
    auroraSecretPrefix: "arn:aws:secretsmanager:us-east-1:435362779479:secret:rds!cluster-cdbd687e-b77b-475e-af80-3d0ccf4a30b0-",
  },
  staging: {
    projectId: "prj_kyXbMhKVA9ipjckoWhhe3gkjnX7Z",
    awsRoleArn: "arn:aws:iam::435362779479:role/simcloud-vercel-platform-staging",
    auroraClusterArn: "arn:aws:rds:us-east-1:435362779479:cluster:simcloud-aurora-staging",
    auroraSecretPrefix: "arn:aws:secretsmanager:us-east-1:435362779479:secret:simcloud-aurora-staging-credentials-manual-",
  },
  prod: {
    projectId: "prj_B7gmPReUV304kZyj1cWt1c53m8Hf",
    awsRoleArn: "arn:aws:iam::435362779479:role/simcloud-vercel-platform-prod",
    auroraClusterArn: "arn:aws:rds:us-east-1:435362779479:cluster:simcloud-aurora-prod",
    auroraSecretPrefix: "arn:aws:secretsmanager:us-east-1:435362779479:secret:simcloud-aurora-prod-credentials-",
  },
};

export function parseAdminEnvironment(value: string | null): AdminEnvironment | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (normalized === "dev" || normalized === "development") return "dev";
  if (normalized === "staging") return "staging";
  if (normalized === "prod" || normalized === "production" || normalized === "main") return "prod";
  return null;
}

function isDeployedRuntime() {
  return process.env.VERCEL === "1" || Boolean(process.env.VERCEL_ENV) || Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME);
}

function deploymentProjectId() {
  return process.env.VERCEL_PROJECT_ID || process.env.SIMFORGE_VERCEL_PROJECT_ID || "";
}

function hasStaticAwsCredentials() {
  return Boolean(
    process.env.AWS_ACCESS_KEY_ID ||
      process.env.AWS_SECRET_ACCESS_KEY ||
      process.env.AWS_SESSION_TOKEN ||
      process.env.SIMFORGE_AWS_ACCESS_KEY_ID ||
      process.env.SIMFORGE_AWS_SECRET_ACCESS_KEY ||
      process.env.SIMFORGE_AWS_SESSION_TOKEN,
  );
}

function anchorFingerprint(environment: AdminEnvironment, projectId: string) {
  const catalog = DEPLOYMENT_CATALOG[environment];
  const digest = createHash("sha256")
    .update([
      environment,
      projectId,
      catalog.awsRoleArn,
      catalog.auroraClusterArn,
      catalog.auroraSecretPrefix,
    ].join("|"))
    .digest("hex")
    .slice(0, 16);
  return `admin-${environment}-${digest}`;
}

function identityFailure(message: string): AdminDeploymentIdentityResult {
  return { ok: false, code: "invalid_admin_deployment_identity", message };
}

function matchesCatalog(environment: AdminEnvironment, projectId: string) {
  const catalog = DEPLOYMENT_CATALOG[environment];
  const auroraSecretArn = process.env.AURORA_SECRET_ARN ?? "";
  return (
    projectId === catalog.projectId &&
    process.env.AWS_ROLE_ARN === catalog.awsRoleArn &&
    process.env.AURORA_CLUSTER_ARN === catalog.auroraClusterArn &&
    auroraSecretArn.startsWith(catalog.auroraSecretPrefix)
  );
}

export function resolveAdminDeploymentIdentity(url?: URL): AdminDeploymentIdentityResult {
  const ignoredEnvParam = Boolean(url?.searchParams.has("env"));
  const simforgeEnv = parseAdminEnvironment(process.env.SIMFORGE_ENV ?? null);
  const publicEnv = parseAdminEnvironment(process.env.NEXT_PUBLIC_ENV ?? null);
  const deployed = isDeployedRuntime();

  if (!deployed && !simforgeEnv && !publicEnv && !deploymentProjectId() && !process.env.AWS_ROLE_ARN && !process.env.AURORA_CLUSTER_ARN && !process.env.AURORA_SECRET_ARN) {
    return {
      ok: true,
      identity: {
        environment: "dev",
        deploymentReadOnly: false,
        projectId: DEPLOYMENT_CATALOG.dev.projectId,
        anchorFingerprint: anchorFingerprint("dev", DEPLOYMENT_CATALOG.dev.projectId),
        ignoredEnvParam,
      },
    };
  }

  if (!deployed && simforgeEnv === "dev" && !publicEnv && !deploymentProjectId() && !process.env.AWS_ROLE_ARN && !process.env.AURORA_CLUSTER_ARN && !process.env.AURORA_SECRET_ARN) {
    return {
      ok: true,
      identity: {
        environment: "dev",
        deploymentReadOnly: false,
        projectId: DEPLOYMENT_CATALOG.dev.projectId,
        anchorFingerprint: anchorFingerprint("dev", DEPLOYMENT_CATALOG.dev.projectId),
        ignoredEnvParam,
      },
    };
  }

  if (!simforgeEnv || !publicEnv || simforgeEnv !== publicEnv) {
    return identityFailure("Admin deployment identity is not configured for this runtime.");
  }

  const projectId = deploymentProjectId();
  if (!projectId) {
    return identityFailure("Admin deployment project identity is not configured for this runtime.");
  }

  if (!matchesCatalog(simforgeEnv, projectId)) {
    return identityFailure("Admin deployment anchors do not match a known environment.");
  }

  if (deployed && hasStaticAwsCredentials()) {
    return identityFailure("Admin deployment must use environment-scoped AWS role credentials.");
  }

  return {
    ok: true,
    identity: {
      environment: simforgeEnv,
      deploymentReadOnly: simforgeEnv !== "dev",
      projectId,
      anchorFingerprint: anchorFingerprint(simforgeEnv, projectId),
      ignoredEnvParam,
    },
  };
}

export function requireAdminDeploymentIdentity(url?: URL): AdminDeploymentIdentity {
  const result = resolveAdminDeploymentIdentity(url);
  if (!result.ok) {
    throw new Error(result.message);
  }
  return result.identity;
}
