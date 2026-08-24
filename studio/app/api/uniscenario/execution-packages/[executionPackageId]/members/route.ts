import { NextResponse } from "next/server";
import { getExecutionPackageMembers } from "@/app/lib/scenario/control-plane-store";
import {
  requireScenarioContext,
  SCENARIO_PRIVATE_CACHE_HEADERS,
} from "@/app/lib/scenario/http";

type Context = { params: Promise<{ executionPackageId: string }> };

export async function GET(_request: Request, route: Context) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const { executionPackageId } = await route.params;

  try {
    const result = await getExecutionPackageMembers(auth.context, executionPackageId);
    return result
      ? NextResponse.json(result, { headers: SCENARIO_PRIVATE_CACHE_HEADERS })
      : NextResponse.json(
          { error: "execution_package_not_found" },
          { status: 404, headers: SCENARIO_PRIVATE_CACHE_HEADERS },
        );
  } catch (error) {
    if (
      error instanceof Error
      && error.message === "uniscenario_execution_package_required_member_missing"
    ) {
      return NextResponse.json(
        { error: error.message },
        { status: 409, headers: SCENARIO_PRIVATE_CACHE_HEADERS },
      );
    }
    throw error;
  }
}
