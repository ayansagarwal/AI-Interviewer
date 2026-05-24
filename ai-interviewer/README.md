# AI Interviewer (Behavioral)

Behavioral-first mock interview platform built with Next.js, TypeScript, and Supabase SSR.

## Getting Started

Install dependencies and start the dev server:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Supabase Configuration

Create a `.env.local` file with:

```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
```

Use the SQL migration script at `supabase/behavioral_schema.sql` inside the Supabase SQL Editor.

## Key Routes

- `/dashboard` for session history.
- `/interview/[id]` for the live behavioral interview workspace.
- `/interview/[id]/report` for the evaluation report.
