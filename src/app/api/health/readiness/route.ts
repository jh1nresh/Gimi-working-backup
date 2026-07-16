import { NextResponse } from "next/server";
import { getEnvReadiness } from "@/lib/envReadiness";

export async function GET() {
  const readiness = getEnvReadiness();
  return NextResponse.json(
    {
      service: "gimi",
      ...readiness,
      note: "This endpoint reports whether keys are present; it never returns secret values.",
    },
    { status: readiness.ok ? 200 : 503 }
  );
}
