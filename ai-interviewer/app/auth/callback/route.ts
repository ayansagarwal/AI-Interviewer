import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function GET(request: NextRequest) {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get("code");

  if (!code) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  const response = NextResponse.redirect(new URL("/dashboard", request.url));

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  const { data, error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  // Upsert the public.users profile row in case the DB trigger hasn't run yet
  // (e.g. for users who signed up before the trigger was applied).
  if (data.user) {
    const { error: upsertError } = await supabase.from("users").upsert(
      {
        id: data.user.id,
        name: data.user.user_metadata?.full_name ?? null,
        email: data.user.email ?? null,
      },
      { onConflict: "id" }
    );
    if (upsertError) {
      console.error("Profile upsert failed:", upsertError.message);
    }
  }

  return response;
}
