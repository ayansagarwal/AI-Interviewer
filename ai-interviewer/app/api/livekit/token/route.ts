import { createClient } from "@/lib/supabase/server";
import { AccessToken } from "livekit-server-sdk";
import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const room = searchParams.get("room");

  if (!room) {
    return NextResponse.json(
      { error: "Room parameter is required" },
      { status: 400 }
    );
  }

  // Initialize Supabase Server client
  const supabase = await createClient();

  // Get current authenticated user
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // Validate session ownership using Supabase RLS policies.
    // Due to RLS, if the user doesn't own this session, select will return no rows or error.
    const { data: session, error: sessionError } = await supabase
      .from("sessions")
      .select("id")
      .eq("id", room)
      .single();

    if (sessionError || !session) {
      return NextResponse.json(
        { error: "Session not found or access denied" },
        { status: 403 }
      );
    }

    // Retrieve user profile to get a human-friendly name if possible
    const { data: profile } = await supabase
      .from("users")
      .select("name, email")
      .eq("id", user.id)
      .single();

    const identity = user.id;
    const name = profile?.name || profile?.email || user.email || "Candidate";

    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;
    const wsUrl = process.env.NEXT_PUBLIC_LIVEKIT_URL;

    if (!apiKey || !apiSecret || !wsUrl) {
      return NextResponse.json(
        { error: "LiveKit server credentials are not configured" },
        { status: 500 }
      );
    }

    // Generate LiveKit token
    const at = new AccessToken(apiKey, apiSecret, {
      identity,
      name,
      ttl: "20m", // Match Modal container timeout (10 min) with a reasonable buffer
    });

    at.addGrant({
      roomJoin: true,
      room: room,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true, // For real-time transcription updates, etc.
    });

    const token = await at.toJwt();

    return NextResponse.json({ token });
  } catch (error) {
    console.error("Error generating LiveKit token:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
