-- ترقية قاعدة بيانات النسخة القديمة إلى V2 بدون حذف بيانات.
-- شغّل هذا الملف مرة واحدة فقط إذا كنت قد أنشأت Supabase من الباكدج السابقة.

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

alter table public.assistant_people add column if not exists target_override numeric(6,2);
alter table public.faculty add column if not exists target_override numeric(6,2);
alter table public.sessions add column if not exists course_id text;

insert into public.role_targets(person_type,role,target_hours,active)
select 'assistant', role, max(target_hours), true from public.assistant_people group by role
on conflict(person_type,role) do nothing;

insert into public.role_targets(person_type,role,target_hours,active)
select 'faculty', role, max(target_hours), true from public.faculty group by role
on conflict(person_type,role) do nothing;

insert into public.courses(id,name,code,program_type,workload_mode,specialty,supervision_required_default,active)
select 'legacy-'||substr(md5(course),1,20), course,
       case when course ~ '^[A-Za-z0-9_-]+$' then course else null end,
       'برنامج عام','target',max(nullif(specialty,'')),bool_or(supervision_required),true
from public.sessions
group by course
on conflict(name) do nothing;

update public.sessions s
set course_id=c.id
from public.courses c
where s.course_id is null and c.name=s.course;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='sessions_course_id_fkey'
  ) THEN
    ALTER TABLE public.sessions
      ADD CONSTRAINT sessions_course_id_fkey FOREIGN KEY(course_id) REFERENCES public.courses(id) ON DELETE RESTRICT;
  END IF;
END $$;

-- RLS للجدولين الجديدين
alter table public.role_targets enable row level security;
alter table public.courses enable row level security;
drop policy if exists "public read role_targets" on public.role_targets;
create policy "public read role_targets" on public.role_targets for select to anon, authenticated using (true);
drop policy if exists "auth write role_targets" on public.role_targets;
create policy "auth write role_targets" on public.role_targets for all to authenticated using (true) with check (true);
drop policy if exists "public read courses" on public.courses;
create policy "public read courses" on public.courses for select to anon, authenticated using (true);
drop policy if exists "auth write courses" on public.courses;
create policy "auth write courses" on public.courses for all to authenticated using (true) with check (true);

create index if not exists idx_sessions_course on public.sessions(course_id);

-- بعد الترقية يفضل تشغيل schema.sql أيضاً؛ أو على الأقل التأكد من وجود triggers الجديدة إذا أردت سجل تعديلات شامل.

-- تحديث triggers وسجل التعديلات ليشمل المواد والنصاب والأعضاء.
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_role_targets_updated on public.role_targets;
create trigger trg_role_targets_updated before update on public.role_targets for each row execute function public.touch_updated_at();
drop trigger if exists trg_courses_updated on public.courses;
create trigger trg_courses_updated before update on public.courses for each row execute function public.touch_updated_at();

create or replace function public.audit_schedule_change()
returns trigger language plpgsql security definer set search_path = public as $$
declare k text;
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
  FOREACH t IN ARRAY ARRAY['role_targets','courses','assistant_people','faculty'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='audit_'||t) THEN
      EXECUTE format('create trigger %I after insert or update or delete on public.%I for each row execute function public.audit_schedule_change()', 'audit_'||t, t);
    END IF;
  END LOOP;
END $$;

-- تصنيف مبدئي للمقررات BTBIO المعروفة كبرنامج خاص وساعات إضافية.
-- يمكن تغيير هذا الإعداد لاحقاً من شاشة إدارة المواد دون تعديل التوزيع.
update public.courses
set program_type='برنامج خاص', workload_mode='extra'
where upper(name) like 'BTBIO%';
