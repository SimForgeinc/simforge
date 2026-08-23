import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getOptionalAwsCredentials } from "../credentials";

const stsSendMock = vi.hoisted(() => vi.fn());
const assumeRoleInputs = vi.hoisted(() => [] as unknown[]);
const vercelOidcProviderMock = vi.hoisted(() =>
  vi.fn().mockReturnValue(async () => ({
    accessKeyId: "oidc-key",
    secretAccessKey: "oidc-secret",
    sessionToken: "oidc-session",
  })),
);

vi.mock("@aws-sdk/client-sts", () => ({
  STSClient: vi.fn().mockImplementation(() => ({
    send: stsSendMock,
  })),
  AssumeRoleWithWebIdentityCommand: vi.fn().mockImplementation((input) => {
    assumeRoleInputs.push(input);
    return { input };
  }),
}));

vi.mock("@vercel/oidc-aws-credentials-provider", () => ({
  awsCredentialsProvider: vercelOidcProviderMock,
}));

const AWS_KEYS = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_PROFILE",
  "SIMFORGE_AWS_ACCESS_KEY_ID",
  "SIMFORGE_AWS_SECRET_ACCESS_KEY",
  "SIMFORGE_AWS_SESSION_TOKEN",
  "AWS_ROLE_ARN",
  "AWS_ROLE_SESSION_DURATION_SECONDS",
  "VERCEL",
  "VERCEL_OIDC_TOKEN",
  "VERCEL_ENV",
  "VERCEL_GIT_COMMIT_SHA",
  "SIMFORGE_SOURCE_SHA",
  "VERCEL_URL",
  "AURORA_REGION",
  "AWS_REGION",
] as const;

describe("getOptionalAwsCredentials", () => {
  const snapshot: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of AWS_KEYS) {
      snapshot[key] = process.env[key];
      delete process.env[key];
    }
    stsSendMock.mockReset();
    vercelOidcProviderMock.mockClear();
    assumeRoleInputs.length = 0;
  });

  afterEach(() => {
    for (const key of AWS_KEYS) {
      if (snapshot[key] === undefined) delete process.env[key];
      else process.env[key] = snapshot[key];
    }
  });

  it("returns undefined when no credentials are set", () => {
    expect(getOptionalAwsCredentials()).toBeUndefined();
  });

  it("prefers SIMFORGE_AWS_* credentials when complete", () => {
    process.env.SIMFORGE_AWS_ACCESS_KEY_ID = "sim-key";
    process.env.SIMFORGE_AWS_SECRET_ACCESS_KEY = "sim-secret";
    process.env.SIMFORGE_AWS_SESSION_TOKEN = "sim-token";
    process.env.AWS_ROLE_ARN = "arn:aws:iam::123456789012:role/vercel-web";
    process.env.VERCEL_OIDC_TOKEN = "ignored-oidc-token";
    process.env.AWS_ACCESS_KEY_ID = "ignored";
    process.env.AWS_SECRET_ACCESS_KEY = "ignored";
    process.env.AWS_SESSION_TOKEN = "ignored";

    expect(getOptionalAwsCredentials()).toEqual({
      accessKeyId: "sim-key",
      secretAccessKey: "sim-secret",
      sessionToken: "sim-token",
    });
  });

  it("returns a Vercel OIDC provider when AWS_ROLE_ARN and VERCEL_OIDC_TOKEN are set", async () => {
    process.env.AWS_ROLE_ARN = "arn:aws:iam::123456789012:role/vercel-web";
    process.env.VERCEL_OIDC_TOKEN = "vercel-oidc-token";
    process.env.VERCEL_ENV = "production";
    process.env.VERCEL_GIT_COMMIT_SHA = "abcdef1234567890";
    process.env.AURORA_REGION = "us-east-1";

    const provider = getOptionalAwsCredentials();
    expect(typeof provider).toBe("function");

    await expect((provider as () => Promise<unknown>)()).resolves.toEqual({
      accessKeyId: "oidc-key",
      secretAccessKey: "oidc-secret",
      sessionToken: "oidc-session",
    });
    expect(vercelOidcProviderMock).toHaveBeenCalledWith({
      roleArn: "arn:aws:iam::123456789012:role/vercel-web",
      roleSessionName: expect.stringContaining("production"),
      durationSeconds: 3_600,
    });
  });

  it("returns a Vercel OIDC provider when the token is request-scoped at runtime", () => {
    process.env.AWS_ROLE_ARN = "arn:aws:iam::123456789012:role/vercel-web";
    process.env.VERCEL = "1";
    process.env.VERCEL_ENV = "production";

    expect(typeof getOptionalAwsCredentials()).toBe("function");
    expect(vercelOidcProviderMock).toHaveBeenCalledWith({
      roleArn: "arn:aws:iam::123456789012:role/vercel-web",
      roleSessionName: expect.stringContaining("production"),
      durationSeconds: 3_600,
    });
  });

  it("does not select Vercel OIDC for a locally projected role without a token", () => {
    process.env.AWS_ROLE_ARN = "arn:aws:iam::123456789012:role/vercel-web";
    process.env.AWS_PROFILE = "simforge";

    expect(getOptionalAwsCredentials()).toBeUndefined();
    expect(vercelOidcProviderMock).not.toHaveBeenCalled();
  });

  it("returns a Vercel OIDC provider when a Function carries the token in request context", () => {
    process.env.AWS_ROLE_ARN = "arn:aws:iam::123456789012:role/vercel-web";
    process.env.VERCEL = "1";
    process.env.VERCEL_ENV = "production";

    expect(typeof getOptionalAwsCredentials()).toBe("function");
    expect(vercelOidcProviderMock).toHaveBeenCalledWith(
      expect.objectContaining({
        roleArn: "arn:aws:iam::123456789012:role/vercel-web",
      }),
    );
  });

  it("uses explicit deployment source SHA in the Vercel role session name", () => {
    process.env.AWS_ROLE_ARN = "arn:aws:iam::123456789012:role/vercel-web";
    process.env.VERCEL_OIDC_TOKEN = "vercel-oidc-token";
    process.env.VERCEL_ENV = "production";
    process.env.SIMFORGE_SOURCE_SHA = "1234567890abcdef";

    expect(typeof getOptionalAwsCredentials()).toBe("function");
    expect(vercelOidcProviderMock).toHaveBeenCalledWith(
      expect.objectContaining({
        roleSessionName: expect.stringContaining("1234567890ab"),
      }),
    );
  });

  it("uses explicit role session duration overrides for Vercel OIDC", () => {
    process.env.AWS_ROLE_ARN = "arn:aws:iam::123456789012:role/vercel-web";
    process.env.VERCEL_OIDC_TOKEN = "vercel-oidc-token";
    process.env.AWS_ROLE_SESSION_DURATION_SECONDS = "1800";

    expect(typeof getOptionalAwsCredentials()).toBe("function");
    expect(vercelOidcProviderMock).toHaveBeenCalledWith(
      expect.objectContaining({ durationSeconds: 1800 }),
    );
  });

  it("falls back to one-hour sessions for invalid Vercel OIDC duration overrides", () => {
    process.env.AWS_ROLE_ARN = "arn:aws:iam::123456789012:role/vercel-web";
    process.env.VERCEL_OIDC_TOKEN = "vercel-oidc-token";
    process.env.AWS_ROLE_SESSION_DURATION_SECONDS = "not-a-number";

    expect(typeof getOptionalAwsCredentials()).toBe("function");
    expect(vercelOidcProviderMock).toHaveBeenCalledWith(
      expect.objectContaining({ durationSeconds: 3600 }),
    );
  });

  it("rejects Vercel OIDC duration overrides above one hour", () => {
    process.env.AWS_ROLE_ARN = "arn:aws:iam::123456789012:role/vercel-web";
    process.env.VERCEL_OIDC_TOKEN = "vercel-oidc-token";
    process.env.AWS_ROLE_SESSION_DURATION_SECONDS = "7200";

    expect(() => getOptionalAwsCredentials()).toThrow(
      /AWS_ROLE_SESSION_DURATION_SECONDS must be between 900 and 3600 seconds/,
    );
    expect(vercelOidcProviderMock).not.toHaveBeenCalled();
  });

  it("rejects Vercel OIDC duration overrides below the STS minimum", () => {
    process.env.AWS_ROLE_ARN = "arn:aws:iam::123456789012:role/vercel-web";
    process.env.VERCEL_OIDC_TOKEN = "vercel-oidc-token";
    process.env.AWS_ROLE_SESSION_DURATION_SECONDS = "60";

    expect(() => getOptionalAwsCredentials()).toThrow(
      /AWS_ROLE_SESSION_DURATION_SECONDS must be between 900 and 3600 seconds/,
    );
    expect(vercelOidcProviderMock).not.toHaveBeenCalled();
  });

  it("passes long-lived AWS_* access keys (no session token) through", () => {
    process.env.AWS_ACCESS_KEY_ID = "AKIA-long-lived";
    process.env.AWS_SECRET_ACCESS_KEY = "secret";

    expect(getOptionalAwsCredentials()).toEqual({
      accessKeyId: "AKIA-long-lived",
      secretAccessKey: "secret",
    });
  });

  it("ignores AWS_* creds when a session token is present (Lambda/ECS role)", () => {
    process.env.AWS_ACCESS_KEY_ID = "ASIA-role-key";
    process.env.AWS_SECRET_ACCESS_KEY = "role-secret";
    process.env.AWS_SESSION_TOKEN = "role-session-token";

    expect(getOptionalAwsCredentials()).toBeUndefined();
  });

  it("returns undefined when only one half of the AWS_* pair is set", () => {
    process.env.AWS_ACCESS_KEY_ID = "only-key";
    expect(getOptionalAwsCredentials()).toBeUndefined();
  });

  it("falls back to AWS_* creds when SIMFORGE_AWS_* is incomplete", () => {
    process.env.SIMFORGE_AWS_ACCESS_KEY_ID = "sim-partial";
    process.env.AWS_ACCESS_KEY_ID = "AKIA-fallback";
    process.env.AWS_SECRET_ACCESS_KEY = "fallback-secret";

    expect(getOptionalAwsCredentials()).toEqual({
      accessKeyId: "AKIA-fallback",
      secretAccessKey: "fallback-secret",
    });
  });
});
