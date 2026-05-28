"use server";

import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";

export async function startNewInterview(formData: FormData) {
  const targetRole = formData.get("targetRole");
  const jobDescription = formData.get("jobDescription");

  if (typeof targetRole !== "string" || targetRole.trim().length === 0) {
    throw new Error("Target role is required.");
  }

  const supabase = await createClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    throw new Error("You must be signed in to start an interview.");
  }

  const { data, error } = await supabase
    .from("sessions")
    .insert({
      user_id: user.id,
      target_role: targetRole.trim(),
      job_description:
        typeof jobDescription === "string" ? jobDescription.trim() : null,
      status: "configured",
    })
    .select("id")
    .single();

  if (error || !data) {
    console.error("Supabase insert error:", error);
    throw new Error("Unable to create a new interview session.");
  }

  redirect(`/interview/${data.id}`);
}
