-- Trading Journal Pro — analisi macro e avvisi notizie.
-- Da eseguire in Supabase → SQL Editor (si può rieseguire senza problemi).
-- Nessun utente legge o scrive direttamente queste tabelle: ci accede solo la funzione "macro-analisi".

-- analisi macro generate (condivise tra gli utenti)
create table if not exists public.tj_macro (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  report jsonb not null
);
create index if not exists tj_macro_created on public.tj_macro (created_at desc);

-- avvisi inviati (promemoria news, dati usciti, notizie dell'ultimo momento)
create table if not exists public.tj_alerts (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  dedup text not null unique,
  kind text not null,
  impatto text,
  titolo text not null,
  testo text,
  direzione text,
  url text
);
create index if not exists tj_alerts_created on public.tj_alerts (created_at desc);

-- telefoni/computer iscritti alle notifiche
create table if not exists public.tj_push (
  endpoint text primary key,
  user_id uuid references auth.users(id) on delete cascade,
  sub jsonb not null,
  created_at timestamptz not null default now()
);

-- impostazioni interne (chiavi delle notifiche, calendario in cache, ultimo controllo)
create table if not exists public.tj_config (
  key text primary key,
  value jsonb
);

alter table public.tj_macro enable row level security;
alter table public.tj_alerts enable row level security;
alter table public.tj_push enable row level security;
alter table public.tj_config enable row level security;
revoke all on public.tj_macro, public.tj_alerts, public.tj_push, public.tj_config from anon, authenticated;

-- controllo automatico ogni 15 minuti (la funzione decide da sola se il mercato è aperto)
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

select cron.unschedule(jobid) from cron.job where jobname = 'tj-sorveglianza-notizie';
select cron.schedule(
  'tj-sorveglianza-notizie',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := 'https://bwiuxthlplazruprybke.supabase.co/functions/v1/macro-analisi',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ3aXV4dGhscGxhenJ1cHJ5YmtlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE3MTU1OTMsImV4cCI6MjEwNzI5MTU5M30.K6nC-eBWAtfQaiIESZw0c0hHKWnsAKrMOzFzVIbFEw4',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ3aXV4dGhscGxhenJ1cHJ5YmtlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE3MTU1OTMsImV4cCI6MjEwNzI5MTU5M30.K6nC-eBWAtfQaiIESZw0c0hHKWnsAKrMOzFzVIbFEw4'
    ),
    body := '{"action":"controlla"}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);
