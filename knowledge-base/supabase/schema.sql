-- מאגר הידע של בוט המאפייה, בפרויקט Supabase "Focus AI Dev - Lesson 11".
--
-- הטבלה documents באותו פרויקט שייכת לתרגיל אחר (חוקת הטניס) ואין לגעת בה.
-- למאפייה טבלה משלה, כדי שאחזור לעולם לא יחזיר קטע מעולם אחר.
--
-- העיקרון: המאגר קובע מה חי, לא המסמך.
--   bakery_kb_docs    שורה לכל סוג מסמך, ובה live_load_id: הטעינה שבתוקף
--   bakery_kb_chunks  הקטעים. כל טעינה מסומנת ב-load_id משלה
--   match_bakery_kb   מחזיר רק קטעים מטעינה חיה
--   bakery_kb_promote מחליף גרסה בטרנזקציה אחת: מעביר מצביע ומוחק את הישן
--
-- לכן החלפה אינה "מחק ואז כתוב". הגרסה החדשה נכתבת לצד הישנה ואינה נראית
-- לבוט, ורק כשהיא שלמה המצביע עובר. טעינה שנכשלה באמצע משאירה את הישנה חיה.

-- ---------------------------------------------------------------- registry
create table if not exists public.bakery_kb_docs (
  doc_id          text primary key
                  check (doc_id in ('delivery-areas', 'price-list', 'policies')),
  display_name    text not null,
  live_load_id    uuid,
  live_version    text,
  source_filename text,
  chunk_count     int,
  char_count      int,          -- בסיס ההשוואה של הבדיקה לפני טעינה
  loaded_at       timestamptz
);

insert into public.bakery_kb_docs (doc_id, display_name) values
  ('delivery-areas', 'אזורי משלוח'),
  ('price-list',     'מחירון'),
  ('policies',       'מדיניות הזמנות ומשלוחים')
on conflict (doc_id) do nothing;

-- ------------------------------------------------------------------ chunks
-- content / metadata / embedding הם השמות שהנוד של n8n כותב אליהם.
-- doc_id ו-load_id נגזרים מה-metadata, כדי שאי אפשר יהיה לכתוב קטע בלי שייכות.
create table if not exists public.bakery_kb_chunks (
  id        bigint generated always as identity primary key,
  content   text not null,
  metadata  jsonb not null default '{}'::jsonb,
  embedding vector(1536),       -- text-embedding-3-small. חייב להתאים לצד השאילתה
  doc_id    text generated always as (metadata->>'doc_id') stored,
  load_id   uuid generated always as ((metadata->>'load_id')::uuid) stored
);

create index if not exists bakery_kb_chunks_doc_load_idx
  on public.bakery_kb_chunks (doc_id, load_id);

-- בכוונה אין אינדקס וקטורי. יש כאן עשרות קטעים, וסריקה מלאה מדויקת ומהירה.
-- אינדקס HNSW עם סינון לפי טעינה חיה עלול להחזיר פחות תוצאות מהמבוקש.

-- -------------------------------------------------------------------- jobs
-- מצב טעינה שעמוד ההעלאה קורא. label הוא המשפט שרמי רואה, כפי שהוא.
create table if not exists public.bakery_kb_jobs (
  id          uuid primary key default gen_random_uuid(),
  doc_id      text not null references public.bakery_kb_docs (doc_id),
  filename    text,
  status      text not null default 'parsing'
              check (status in ('parsing', 'loading', 'done', 'stopped', 'failed')),
  label       text not null default 'קוראים את הקובץ',
  detail      jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ------------------------------------------------------------------ search
-- החתימה (query_embedding, match_count, filter) היא מה שהנוד של n8n שולח.
create or replace function public.match_bakery_kb(
  query_embedding vector(1536),
  match_count     int   default 5,
  filter          jsonb default '{}'::jsonb
)
returns table (id bigint, content text, metadata jsonb, similarity float)
language sql stable
security invoker
set search_path = public
as $$
  select c.id, c.content, c.metadata,
         1 - (c.embedding <=> query_embedding) as similarity
  from public.bakery_kb_chunks c
  join public.bakery_kb_docs d
    on d.doc_id = c.doc_id
   and d.live_load_id = c.load_id
  where c.metadata @> filter
  order by c.embedding <=> query_embedding
  limit match_count;
$$;

-- ----------------------------------------------------------------- promote
-- נקרא אחרי שהקטעים של טעינה חדשה נכתבו. בטרנזקציה אחת:
--   1. מוודא שהטעינה באמת כתבה קטעים
--   2. מעביר את המצביע אליה
--   3. מוחק כל קטע אחר של אותו מסמך: הגרסה הקודמת ושאריות של טעינות שנכשלו
create or replace function public.bakery_kb_promote(
  p_doc_id   text,
  p_load_id  uuid,
  p_version  text,
  p_filename text,
  p_chars    int
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  n_new     int;
  n_removed int;
begin
  select count(*) into n_new
  from public.bakery_kb_chunks
  where doc_id = p_doc_id and load_id = p_load_id;

  if n_new = 0 then
    return jsonb_build_object('ok', false, 'reason', 'no_chunks_written');
  end if;

  update public.bakery_kb_docs
     set live_load_id    = p_load_id,
         live_version    = p_version,
         source_filename = p_filename,
         chunk_count     = n_new,
         char_count      = p_chars,
         loaded_at       = now()
   where doc_id = p_doc_id;

  delete from public.bakery_kb_chunks
   where doc_id = p_doc_id
     and load_id is distinct from p_load_id;
  get diagnostics n_removed = row_count;

  return jsonb_build_object('ok', true, 'chunks', n_new, 'removed', n_removed);
end;
$$;

-- ---------------------------------------------------------------- security
-- n8n ניגש עם מפתח service_role, שעוקף RLS. לאף אחד אחר אין גישה:
-- RLS פעיל בלי מדיניות, וההרשאות נשללות מ-anon ומ-authenticated.
alter table public.bakery_kb_docs   enable row level security;
alter table public.bakery_kb_chunks enable row level security;
alter table public.bakery_kb_jobs   enable row level security;

revoke all on public.bakery_kb_docs, public.bakery_kb_chunks, public.bakery_kb_jobs
  from anon, authenticated;
revoke execute on function public.match_bakery_kb(vector, int, jsonb)
  from public, anon, authenticated;
revoke execute on function public.bakery_kb_promote(text, uuid, text, text, int)
  from public, anon, authenticated;
grant execute on function public.match_bakery_kb(vector, int, jsonb)       to service_role;
grant execute on function public.bakery_kb_promote(text, uuid, text, text, int) to service_role;
