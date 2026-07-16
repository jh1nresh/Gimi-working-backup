import { NextResponse } from "next/server";

export async function GET() {
  const agentId = process.env.ELEVENLABS_AGENT_ID;
  const apiKey = process.env.ELEVENLABS_API_KEY;

  if (!agentId || !apiKey) {
    return NextResponse.json(
      { error: "Missing ELEVENLABS_AGENT_ID or ELEVENLABS_API_KEY" },
      { status: 501 },
    );
  }

  const response = await fetch(
    `https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=${encodeURIComponent(agentId)}`,
    {
      headers: {
        "xi-api-key": apiKey,
      },
      cache: "no-store",
    },
  );

  if (!response.ok) {
    return NextResponse.json(
      { error: "Failed to get ElevenLabs conversation token" },
      { status: 502 },
    );
  }

  const body = (await response.json()) as { token?: string };

  if (!body.token) {
    return NextResponse.json(
      { error: "ElevenLabs response did not include a token" },
      { status: 502 },
    );
  }

  return NextResponse.json({ conversationToken: body.token });
}
