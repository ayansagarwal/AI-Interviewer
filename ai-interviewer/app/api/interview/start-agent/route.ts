import { createClient } from "@/lib/supabase/server";
import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  try {
    const { sessionId } = await request.json();

    if (!sessionId) {
      return NextResponse.json(
        { error: "sessionId is required" },
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

    // Validate session ownership
    const { data: session, error: sessionError } = await supabase
      .from("sessions")
      .select("id, target_role, job_description")
      .eq("id", sessionId)
      .single();

    if (sessionError || !session) {
      return NextResponse.json(
        { error: "Session not found or access denied" },
        { status: 403 }
      );
    }

    const modalTriggerUrl = process.env.MODAL_AGENT_TRIGGER_URL;

    if (!modalTriggerUrl) {
      console.warn("MODAL_AGENT_TRIGGER_URL is not set. Simulating agent launch.");
      return NextResponse.json({
        success: true,
        mocked: true,
        message: "Agent trigger simulated (no MODAL_AGENT_TRIGGER_URL set)",
      });
    }

    // Call Modal asynchronously to trigger the agent container.
    // We run it with a quick timeout to avoid blocking the frontend if the cold start is slow.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000);

    try {
      const webhookSecret = process.env.MODAL_WEBHOOK_SECRET;
      const response = await fetch(modalTriggerUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(webhookSecret ? { Authorization: `Bearer ${webhookSecret}` } : {}),
        },
        body: JSON.stringify({
          room_name: sessionId,
          user_id: user.id,
          target_role: session.target_role,
          job_description: session.job_description,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`Modal returned status ${response.status}`);
      }

      const responseData = await response.json();
      return NextResponse.json({
        success: true,
        message: "Agent triggered successfully",
        data: responseData,
      });
    } catch (fetchError: any) {
      clearTimeout(timeoutId);
      console.error("Failed to call Modal agent trigger endpoint:", fetchError);
      
      return NextResponse.json(
        {
          success: false,
          error: "Failed to communicate with Modal backend",
          details: fetchError.message || String(fetchError),
        },
        { status: 502 }
      );
    }
  } catch (error: any) {
    console.error("Error in start-agent endpoint:", error);
    return NextResponse.json(
      { error: "Internal server error", details: error.message },
      { status: 500 }
    );
  }
}
