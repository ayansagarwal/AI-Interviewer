import { createClient } from "@/lib/supabase/server";
import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  try {
    const { sessionId, speaker, text } = await request.json();

    if (!sessionId || !speaker || !text) {
      return NextResponse.json(
        { error: "Missing required fields: sessionId, speaker, text" },
        { status: 400 }
      );
    }

    if (speaker !== "candidate" && speaker !== "interviewer") {
      return NextResponse.json(
        { error: "Invalid speaker. Must be 'candidate' or 'interviewer'" },
        { status: 400 }
      );
    }

    // Limit text length to prevent abuse (10KB is more than enough for any single utterance)
    if (typeof text !== "string" || text.length > 10000) {
      return NextResponse.json(
        { error: "Text too long or invalid" },
        { status: 400 }
      );
    }

    // Initialize Supabase server-side client
    const supabase = await createClient();

    // Get the authenticated user
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Validate that the user owns the corresponding session
    // (RLS on sessions table automatically restricts this, but a select verification provides clean validation)
    const { data: session, error: sessionError } = await supabase
      .from("sessions")
      .select("id")
      .eq("id", sessionId)
      .single();

    if (sessionError || !session) {
      return NextResponse.json(
        { error: "Session not found or access denied" },
        { status: 403 }
      );
    }

    // Insert the transcript turn using the authenticated user's session
    const { error: insertError } = await supabase
      .from("transcripts")
      .insert({
        session_id: sessionId,
        speaker: speaker,
        text_content: text.trim(),
      });

    if (insertError) {
      console.error("Database error inserting transcript:", insertError);
      return NextResponse.json(
        { error: "Failed to save transcript to database" },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true, message: "Transcript logged successfully" });
  } catch (error: any) {
    console.error("Error in transcript proxy API route:", error);
    return NextResponse.json(
      { error: "Internal server error", details: error.message },
      { status: 500 }
    );
  }
}
