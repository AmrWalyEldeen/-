-- نظام إدارة جدول معامل قسم علم الحيوان — Schema V2
-- يشمل: المواد، نوع البرنامج، طريقة احتساب الساعات، النصاب حسب الدرجة، الأعضاء، الجلسات والتوزيعات.
-- شغّل هذا الملف مرة واحدة داخل Supabase > SQL Editor لمشروع جديد.

create extension if not exists pgcrypto;

create table if not exists public.role_targets (
  person_type text not null check (person_type in ('assistant','faculty')),
  role text not null,
  target_hours numeric(6,2) not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(person_type, role)
);

create table if not exists public.courses (
  id text primary key,
  code text,
  name text not null unique,
  program_type text not null default 'برنامج عام',
  workload_mode text not null default 'target' check (workload_mode in ('target','extra','excluded')),
  specialty text,
  supervision_required_default boolean not null default true,
  notes text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.assistant_people (
  id integer primary key,
  name text not null unique,
  display_name text,
  title text,
  role text not null,
  sort_order integer,
  target_hours numeric(6,2) not null default 0,
  target_override numeric(6,2),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.faculty (
  id integer primary key,
  name text not null unique,
  title text,
  role text not null,
  status text,
  specialty text,
  target_hours numeric(6,2) not null default 0,
  target_override numeric(6,2),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.sessions (
  id text primary key,
  source_row integer,
  day text not null,
  day_order integer not null,
  start_time time not null,
  end_time time not null,
  duration_hours numeric(6,2) not null,
  course_id text references public.courses(id) on delete restrict,
  course text not null,
  specialty text,
  lab_no integer not null check (lab_no between 1 and 7),
  supervision_required boolean not null default true,
  notes text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(day, start_time, end_time, course, lab_no)
);

create table if not exists public.assistant_assignments (
  session_id text not null references public.sessions(id) on delete cascade,
  person_id integer not null references public.assistant_people(id) on delete cascade,
  position integer not null check (position between 1 and 5),
  created_at timestamptz not null default now(),
  primary key(session_id, position),
  unique(session_id, person_id)
);

create table if not exists public.supervisor_assignments (
  session_id text not null references public.sessions(id) on delete cascade,
  faculty_id integer not null references public.faculty(id) on delete cascade,
  position integer not null check (position between 1 and 10),
  created_at timestamptz not null default now(),
  primary key(session_id, position),
  unique(session_id, faculty_id)
);

create table if not exists public.app_meta (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.change_log (
  id bigint generated always as identity primary key,
  table_name text not null,
  row_key text,
  action text not null,
  old_data jsonb,
  new_data jsonb,
  changed_at timestamptz not null default now(),
  changed_by uuid default auth.uid()
);

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- updated_at triggers
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['role_targets','courses','assistant_people','faculty','sessions'] LOOP
    EXECUTE format('drop trigger if exists %I on public.%I', 'trg_'||t||'_updated', t);
    EXECUTE format('create trigger %I before update on public.%I for each row execute function public.touch_updated_at()', 'trg_'||t||'_updated', t);
  END LOOP;
END $$;

create or replace function public.audit_schedule_change()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  k text;
begin
  if tg_table_name = 'sessions' then k := coalesce(new.id, old.id);
  elsif tg_table_name = 'courses' then k := coalesce(new.id, old.id);
  elsif tg_table_name = 'assistant_people' then k := coalesce(new.id, old.id)::text;
  elsif tg_table_name = 'faculty' then k := coalesce(new.id, old.id)::text;
  elsif tg_table_name = 'role_targets' then k := coalesce(new.person_type,old.person_type)||':'||coalesce(new.role,old.role);
  elsif tg_table_name in ('assistant_assignments','supervisor_assignments') then k := coalesce(new.session_id, old.session_id);
  else k := null;
  end if;

  insert into public.change_log(table_name,row_key,action,old_data,new_data,changed_by)
  values(tg_table_name,k,tg_op,
    case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) else null end,
    case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) else null end,
    auth.uid());
  return coalesce(new,old);
end;
$$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['role_targets','courses','assistant_people','faculty','sessions','assistant_assignments','supervisor_assignments'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='audit_'||t) THEN
      EXECUTE format('create trigger %I after insert or update or delete on public.%I for each row execute function public.audit_schedule_change()', 'audit_'||t, t);
    END IF;
  END LOOP;
END $$;

-- RLS
alter table public.role_targets enable row level security;
alter table public.courses enable row level security;
alter table public.assistant_people enable row level security;
alter table public.faculty enable row level security;
alter table public.sessions enable row level security;
alter table public.assistant_assignments enable row level security;
alter table public.supervisor_assignments enable row level security;
alter table public.app_meta enable row level security;
alter table public.change_log enable row level security;

-- القراءة عامة؛ التعديل للمستخدم المسجل فقط.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['role_targets','courses','assistant_people','faculty','sessions','assistant_assignments','supervisor_assignments','app_meta'] LOOP
    EXECUTE format('drop policy if exists %I on public.%I', 'public read '||t, t);
    EXECUTE format('create policy %I on public.%I for select to anon, authenticated using (true)', 'public read '||t, t);
    EXECUTE format('drop policy if exists %I on public.%I', 'auth write '||t, t);
    EXECUTE format('create policy %I on public.%I for all to authenticated using (true) with check (true)', 'auth write '||t, t);
  END LOOP;
END $$;

drop policy if exists "auth read change_log" on public.change_log;
create policy "auth read change_log" on public.change_log for select to authenticated using (true);

create index if not exists idx_sessions_day_time on public.sessions(day_order,start_time,end_time);
create index if not exists idx_sessions_course on public.sessions(course_id);
create index if not exists idx_assistant_person on public.assistant_assignments(person_id);
create index if not exists idx_supervisor_faculty on public.supervisor_assignments(faculty_id);
create index if not exists idx_change_log_time on public.change_log(changed_at desc);
