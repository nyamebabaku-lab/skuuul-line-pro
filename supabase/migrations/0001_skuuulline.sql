-- Skuuul-Line Pro live platform: many schools, every account approved, one generic records table per school.
-- Lives in its own schema ("skuuulline") so it can share a Supabase project with other apps safely.

create schema if not exists skuuulline;
grant usage on schema skuuulline to anon, authenticated, service_role;

-- ---------------------------------------------------------------- tables
create table skuuulline.config (
  id boolean primary key default true check (id),
  reserved_super_email text not null default 'nyamebabaku@gmail.com'
);
insert into skuuulline.config default values;

create table skuuulline.schools (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  code text not null unique,
  status text not null default 'pending' check (status in ('pending', 'active', 'suspended')),
  owner_id uuid references auth.users on delete set null,
  city text,
  phone text,
  email text,
  settings jsonb not null default '{}',
  status_reason text,
  created_at timestamptz not null default now()
);

create table skuuulline.profiles (
  user_id uuid primary key references auth.users on delete cascade,
  school_id uuid references skuuulline.schools on delete cascade,
  role text not null check (role in ('superadmin', 'admin', 'headteacher', 'teacher', 'accountant', 'librarian', 'storekeeper',
                                     'transport', 'canteen', 'hostel', 'staff', 'kiosk', 'parent', 'student')),
  status text not null default 'pending' check (status in ('pending', 'active', 'suspended', 'deactivated')),
  name text not null,
  email text,
  phone text,
  admission_no text,          -- typed at sign-up by parents and students
  match_id text,              -- the student record that admission number matched
  match_label text,           -- e.g. "Kofi Mensah · JHS 2", shown to whoever approves
  linked_id text,             -- the student / staff / parent record this account acts as
  is_owner boolean not null default false,
  status_reason text,
  approved_by uuid,
  approved_at timestamptz,
  last_login timestamptz,
  created_at timestamptz not null default now(),
  check ((role = 'superadmin') = (school_id is null))
);
create index profiles_school on skuuulline.profiles (school_id, status);

create table skuuulline.records (
  school_id uuid not null references skuuulline.schools on delete cascade,
  col text not null,
  id text not null,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  primary key (school_id, col, id)
);
create index records_admission on skuuulline.records (school_id, upper(trim(data->>'admissionNo'))) where col = 'students';
create index records_parent on skuuulline.records (school_id, (data->>'parentId')) where col = 'students';

-- role × collection → read / write scope (generated from src/lib/access.js; see below)
create table skuuulline.access (
  role text not null,
  col text not null,
  rd text not null check (rd in ('all', 'fam', 'cls', 'self', 'mine', 'none')),
  wr text not null check (wr in ('all', 'fam', 'cls', 'self', 'mine', 'none')),
  primary key (role, col)
);

create table skuuulline.audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  user_id uuid,
  school_id uuid references skuuulline.schools on delete cascade,
  action text not null,
  detail text
);
create index audit_school on skuuulline.audit_log (school_id, at desc);

-- ---------------------------------------------------------------- helpers (run as owner so policies can use them)
create or replace function skuuulline.me() returns skuuulline.profiles language sql stable security definer set search_path = skuuulline as $$
  select * from profiles where user_id = auth.uid();
$$;
create or replace function skuuulline.is_super() returns boolean language sql stable security definer set search_path = skuuulline as $$
  select exists (select 1 from profiles where user_id = auth.uid() and role = 'superadmin' and status = 'active');
$$;
-- The caller's school, only while both the account and the school are active.
create or replace function skuuulline.my_school() returns uuid language sql stable security definer set search_path = skuuulline as $$
  select p.school_id from profiles p join schools s on s.id = p.school_id
  where p.user_id = auth.uid() and p.status = 'active' and s.status = 'active';
$$;
-- The caller's school whatever its status (for the waiting-for-approval screen).
create or replace function skuuulline.my_school_any() returns uuid language sql stable security definer set search_path = skuuulline as $$
  select school_id from profiles where user_id = auth.uid();
$$;
create or replace function skuuulline.my_role() returns text language sql stable security definer set search_path = skuuulline as $$
  select role from profiles where user_id = auth.uid() and status = 'active';
$$;
create or replace function skuuulline.my_link() returns text language sql stable security definer set search_path = skuuulline as $$
  select linked_id from profiles where user_id = auth.uid() and status = 'active';
$$;
-- Student record ids a student or parent may see.
create or replace function skuuulline.my_students() returns text[] language sql stable security definer set search_path = skuuulline as $$
  select case p.role
    when 'student' then array[p.linked_id]
    when 'parent' then coalesce((select array_agg(r.id) from records r where r.school_id = p.school_id and r.col = 'students'
                                 and r.data->>'parentId' = p.linked_id), '{}')
    else '{}' end
  from profiles p where p.user_id = auth.uid() and p.status = 'active';
$$;
create or replace function skuuulline.my_classes() returns text[] language sql stable security definer set search_path = skuuulline as $$
  select coalesce(array_agg(distinct r.data->>'classId'), '{}') from records r
  where r.school_id = skuuulline.my_school() and r.col = 'students' and r.id = any (skuuulline.my_students());
$$;
create or replace function skuuulline.is_school_admin(sid uuid) returns boolean language sql stable security definer set search_path = skuuulline as $$
  select exists (select 1 from profiles where user_id = auth.uid() and role = 'admin' and status = 'active' and school_id = sid);
$$;

-- Does a record fall inside a scope? Called with values computed once per query (see policies).
create or replace function skuuulline.in_scope(scope text, r_col text, r_id text, d jsonb, uid text, link text, studs text[], classes text[])
returns boolean language sql immutable as $$
  select case scope
    when 'all' then true
    when 'fam' then coalesce(
        case when r_col = 'students' then r_id end,
        case when r_col = 'photos' and r_id like 'Student:%' then substr(r_id, 9) end,
        d->>'studentId', case when d->>'memberType' = 'Student' then d->>'memberId' end,
        case when d->>'personType' = 'Student' then d->>'personId' end) = any (studs)
    when 'cls' then d->>'classId' = any (classes)
    when 'self' then r_id = link
    when 'mine' then d->>'fromId' = uid or d->>'toId' = uid
                     or (link is not null and (d->>'staffId' = link or (d->>'personType' = 'Staff' and d->>'personId' = link)))
    else false end;
$$;

create or replace function skuuulline.row_ok(mode text, role text, r_col text, r_id text, d jsonb, uid text, link text, studs text[], classes text[])
returns boolean language sql stable set search_path = skuuulline as $$
  select exists (select 1 from access a where a.role = row_ok.role and a.col = r_col
                 and in_scope(case mode when 'r' then a.rd else a.wr end, r_col, r_id, d, uid, link, studs, classes));
$$;

create or replace function skuuulline.new_code() returns text language plpgsql as $$
declare c text;
begin
  loop
    c := upper(substr(translate(md5(random()::text || clock_timestamp()::text), '01lo', ''), 1, 6));
    exit when length(c) = 6 and not exists (select 1 from skuuulline.schools where code = c);
  end loop;
  return c;
end $$;

create or replace function skuuulline.short_id(prefix text) returns text language sql volatile as $$
  select prefix || '_' || substr(md5(random()::text || clock_timestamp()::text), 1, 10);
$$;

create or replace function skuuulline.audit(act text, det text, sid uuid default null) returns void
language sql security definer set search_path = skuuulline as $$
  insert into audit_log (user_id, school_id, action, detail) values (auth.uid(), sid, act, det);
$$;

-- ---------------------------------------------------------------- row-level security
alter table skuuulline.config enable row level security;
alter table skuuulline.schools enable row level security;
alter table skuuulline.profiles enable row level security;
alter table skuuulline.records enable row level security;
alter table skuuulline.access enable row level security;
alter table skuuulline.audit_log enable row level security;

create policy access_read on skuuulline.access for select to authenticated using (true);

create policy schools_read on skuuulline.schools for select to authenticated
  using (id = (select skuuulline.my_school_any()) or (select skuuulline.is_super()));

create policy profiles_read on skuuulline.profiles for select to authenticated using (
  user_id = auth.uid()
  or (select skuuulline.is_super())
  or (school_id = (select skuuulline.my_school()) and (
        (select skuuulline.my_role()) = 'admin'
        or (status = 'active' and ((select skuuulline.my_role()) not in ('parent', 'student', 'kiosk') or role not in ('parent', 'student', 'kiosk'))))));

create policy records_read on skuuulline.records for select to authenticated using (
  school_id = (select skuuulline.my_school())
  and skuuulline.row_ok('r', (select skuuulline.my_role()), col, id, data, (select auth.uid()::text), (select skuuulline.my_link()),
                     (select skuuulline.my_students()), (select skuuulline.my_classes())));
create policy records_insert on skuuulline.records for insert to authenticated with check (
  school_id = (select skuuulline.my_school())
  and skuuulline.row_ok('w', (select skuuulline.my_role()), col, id, data, (select auth.uid()::text), (select skuuulline.my_link()),
                     (select skuuulline.my_students()), (select skuuulline.my_classes())));
create policy records_update on skuuulline.records for update to authenticated using (
  school_id = (select skuuulline.my_school())
  and skuuulline.row_ok('w', (select skuuulline.my_role()), col, id, data, (select auth.uid()::text), (select skuuulline.my_link()),
                     (select skuuulline.my_students()), (select skuuulline.my_classes())))
  with check (
  school_id = (select skuuulline.my_school())
  and skuuulline.row_ok('w', (select skuuulline.my_role()), col, id, data, (select auth.uid()::text), (select skuuulline.my_link()),
                     (select skuuulline.my_students()), (select skuuulline.my_classes())));
create policy records_delete on skuuulline.records for delete to authenticated using (
  school_id = (select skuuulline.my_school())
  and skuuulline.row_ok('w', (select skuuulline.my_role()), col, id, data, (select auth.uid()::text), (select skuuulline.my_link()),
                     (select skuuulline.my_students()), (select skuuulline.my_classes())));

create policy audit_read on skuuulline.audit_log for select to authenticated
  using ((select skuuulline.is_super()) or skuuulline.is_school_admin(school_id));

-- Records always carry who changed them and when.
create or replace function skuuulline.stamp_record() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end $$;
create trigger records_stamp before insert or update on skuuulline.records for each row execute function skuuulline.stamp_record();

grant select on skuuulline.schools, skuuulline.profiles, skuuulline.access, skuuulline.audit_log to authenticated;
grant select, insert, update, delete on skuuulline.records to authenticated;

-- ---------------------------------------------------------------- sign-up
create or replace function skuuulline.my_context() returns jsonb language sql stable security definer set search_path = skuuulline as $$
  select jsonb_build_object(
    'profile', (select to_jsonb(p) from profiles p where p.user_id = auth.uid()),
    'school', (select to_jsonb(s) - 'settings' || jsonb_build_object('settings', s.settings)
               from schools s join profiles p on p.school_id = s.id where p.user_id = auth.uid()),
    'superExists', exists (select 1 from profiles where role = 'superadmin'));
$$;

create or replace function skuuulline.school_by_code(code text) returns jsonb language sql stable security definer set search_path = skuuulline as $$
  select jsonb_build_object('id', id, 'name', name, 'city', city, 'logo', settings->'logo', 'theme', settings->'theme', 'status', status)
  from schools where schools.code = upper(trim(school_by_code.code)) and status <> 'suspended';
$$;

-- A school Owner registers the school; both wait for the Super Admin.
create or replace function skuuulline.register_school(school jsonb, full_name text, phone text default null)
returns skuuulline.profiles language plpgsql security definer set search_path = skuuulline as $$
declare sid uuid; p profiles;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  if exists (select 1 from profiles where user_id = auth.uid()) then raise exception 'This account is already registered with Skuuul-Line Pro'; end if;
  if coalesce(trim(school->>'name'), '') = '' then raise exception 'Enter the school name'; end if;
  if length(coalesce(school->'settings'->>'logo', '')) > 400000 then raise exception 'The logo is too large'; end if;
  insert into schools (name, code, city, phone, email, settings, owner_id)
  values (trim(school->>'name'), new_code(), school->>'city', school->>'phone', school->>'email',
          coalesce(school->'settings', '{}') || jsonb_build_object('schoolName', trim(school->>'name')), auth.uid())
  returning id into sid;
  insert into profiles (user_id, school_id, role, name, email, phone, is_owner)
  values (auth.uid(), sid, 'admin', trim(full_name), auth.email(), phone, true) returning * into p;
  perform audit('School registered', (school->>'name') || ' — owner ' || full_name, sid);
  return p;
end $$;

-- Everyone else joins a school with its code. Parents and students are matched by admission number.
create or replace function skuuulline.join_school(code text, member_role text, full_name text, phone text default null, admission_no text default null)
returns skuuulline.profiles language plpgsql security definer set search_path = skuuulline as $$
declare s schools; stu records; p profiles; cls text;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  if exists (select 1 from profiles where user_id = auth.uid()) then raise exception 'This account is already registered with Skuuul-Line Pro'; end if;
  if member_role not in ('admin', 'headteacher', 'teacher', 'accountant', 'librarian', 'storekeeper', 'transport', 'canteen', 'hostel', 'staff', 'kiosk', 'parent', 'student') then
    raise exception 'Choose a valid role';
  end if;
  if coalesce(trim(full_name), '') = '' then raise exception 'Enter your full name'; end if;
  select * into s from schools where schools.code = upper(trim(join_school.code)) and status <> 'suspended';
  if s.id is null then raise exception 'No school has that code'; end if;
  if member_role in ('parent', 'student') then
    if coalesce(trim(admission_no), '') = '' then raise exception 'Enter the admission number'; end if;
    select * into stu from records r where r.school_id = s.id and r.col = 'students'
      and upper(trim(r.data->>'admissionNo')) = upper(trim(admission_no)) limit 1;
    if stu.id is null then raise exception 'That admission number was not found at %', s.name; end if;
    if member_role = 'student' and exists (select 1 from profiles where school_id = s.id and role = 'student' and linked_id = stu.id) then
      raise exception 'This student already has an account';
    end if;
    select r.data->>'name' into cls from records r where r.school_id = s.id and r.col = 'classes' and r.id = stu.data->>'classId';
  end if;
  insert into profiles (user_id, school_id, role, name, email, phone, admission_no, match_id, match_label, linked_id)
  values (auth.uid(), s.id, member_role, trim(full_name), auth.email(), phone, nullif(upper(trim(admission_no)), ''), stu.id,
          case when stu.id is not null then concat_ws(' · ', concat_ws(' ', stu.data->>'firstName', stu.data->>'lastName'), cls, stu.data->>'admissionNo') end,
          case when member_role = 'student' then stu.id end)
  returning * into p;
  perform audit('Account requested', full_name || ' as ' || member_role, s.id);
  return p;
end $$;

-- Only the reserved email, and only while no Super Admin exists.
create or replace function skuuulline.claim_super_admin(full_name text) returns skuuulline.profiles
language plpgsql security definer set search_path = skuuulline as $$
declare p profiles;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  if exists (select 1 from profiles where role = 'superadmin') then raise exception 'A Super Admin already exists'; end if;
  if lower(auth.email()) <> lower((select reserved_super_email from config)) then raise exception 'This email is not the reserved Super Admin email'; end if;
  delete from profiles where user_id = auth.uid();
  insert into profiles (user_id, role, name, email, status, approved_at)
  values (auth.uid(), 'superadmin', trim(full_name), auth.email(), 'active', now()) returning * into p;
  perform audit('Super Admin claimed', full_name);
  return p;
end $$;

create or replace function skuuulline.touch_login() returns void language sql security definer set search_path = skuuulline as $$
  update profiles set last_login = now() where user_id = auth.uid();
$$;

-- ---------------------------------------------------------------- account management
-- Super Admin: any account. School Owner/Admin: accounts of their own school (not themselves, not the owner).
create or replace function skuuulline.assert_can_manage(t skuuulline.profiles) returns void
language plpgsql stable security definer set search_path = skuuulline as $$
begin
  if t.user_id is null then raise exception 'Account not found'; end if;
  if t.user_id = auth.uid() then raise exception 'You cannot change your own account'; end if;
  if is_super() then return; end if;
  if t.role = 'superadmin' then raise exception 'Only a Super Admin can manage this account'; end if;
  if not is_school_admin(t.school_id) or my_school() is distinct from t.school_id then
    raise exception 'Only this school''s Owner/Admin or the Super Admin can do this';
  end if;
  if t.is_owner then raise exception 'Only the Super Admin can change the school owner''s account'; end if;
end $$;

-- On approval, connect the account to a record: staff get a staff record (matched by phone/email or created),
-- parents are linked to the matched child's parent record (created if the child has none).
create or replace function skuuulline.link_account(t skuuulline.profiles) returns text
language plpgsql security definer set search_path = skuuulline as $$
declare link text; stu records; first text; last text; label text; n int;
begin
  if t.linked_id is not null or t.role in ('superadmin', 'admin', 'kiosk') then return t.linked_id; end if;
  first := split_part(trim(t.name), ' ', 1);
  last := nullif(trim(substr(trim(t.name), length(first) + 1)), '');
  if t.role = 'parent' then
    select * into stu from records where school_id = t.school_id and col = 'students' and id = t.match_id;
    if stu.id is null then return null; end if;
    link := nullif(stu.data->>'parentId', '');
    if link is null then
      link := short_id('par');
      insert into records (school_id, col, id, data) values (t.school_id, 'parents', link, jsonb_build_object(
        'id', link, 'title', '', 'firstName', first, 'lastName', coalesce(last, ''), 'gender', '', 'relation', 'Parent',
        'phone', coalesce(t.phone, ''), 'altPhone', '', 'email', coalesce(t.email, ''), 'occupation', '', 'address', ''));
      update records set data = data || jsonb_build_object('parentId', link) where school_id = t.school_id and col = 'students' and id = stu.id;
    end if;
    return link;
  end if;
  if t.role = 'student' then return t.match_id; end if;
  -- staff roles
  select id into link from records where school_id = t.school_id and col = 'staff' and (
    (t.email is not null and t.email not like '%@phone.skuuulline.app' and lower(data->>'email') = lower(t.email))
    or (length(regexp_replace(coalesce(t.phone, ''), '\D', '', 'g')) >= 9
        and right(regexp_replace(coalesce(data->>'phone', ''), '\D', '', 'g'), 9) = right(regexp_replace(t.phone, '\D', '', 'g'), 9)))
    and not exists (select 1 from profiles o where o.school_id = t.school_id and o.linked_id = records.id and o.user_id <> t.user_id)
  limit 1;
  if link is not null then return link; end if;
  label := case t.role when 'headteacher' then 'Head Teacher' when 'teacher' then 'Teacher' when 'accountant' then 'Accountant'
    when 'librarian' then 'Librarian' when 'storekeeper' then 'Storekeeper' when 'transport' then 'Transport Officer'
    when 'canteen' then 'Canteen Manager' when 'hostel' then 'Hostel Manager' else 'Support Staff' end;
  select count(*) + 1 into n from records where school_id = t.school_id and col = 'staff';
  link := short_id('stf');
  insert into records (school_id, col, id, data) values (t.school_id, 'staff', link, jsonb_build_object(
    'id', link, 'staffNo', 'ST/' || lpad(n::text, 3, '0'), 'title', '', 'firstName', first, 'lastName', coalesce(last, ''),
    'gender', '', 'role', label, 'department', case when t.role in ('teacher', 'headteacher') then 'Academic' else label end,
    'phone', coalesce(t.phone, ''), 'email', case when t.email like '%@phone.skuuulline.app' then '' else coalesce(t.email, '') end,
    'qualification', '', 'salary', 0, 'allowances', 0, 'dateJoined', to_char(now(), 'YYYY-MM-DD'), 'status', 'Active',
    'ssnitNo', '', 'bank', '', 'accountNo', ''));
  return link;
end $$;

create or replace function skuuulline.set_account_status(target uuid, new_status text, reason text default null) returns skuuulline.profiles
language plpgsql security definer set search_path = skuuulline as $$
declare t profiles;
begin
  if new_status not in ('pending', 'active', 'suspended', 'deactivated') then raise exception 'Unknown status'; end if;
  select * into t from profiles where user_id = target;
  perform assert_can_manage(t);
  if t.role = 'superadmin' and new_status <> 'active'
     and not exists (select 1 from profiles where role = 'superadmin' and status = 'active' and user_id <> target) then
    raise exception 'The last Super Admin cannot be switched off';
  end if;
  update profiles set status = new_status, status_reason = reason,
    linked_id = case when new_status = 'active' then link_account(t) else linked_id end,
    approved_by = case when new_status = 'active' and approved_at is null then auth.uid() else approved_by end,
    approved_at = case when new_status = 'active' and approved_at is null then now() else approved_at end
  where user_id = target returning * into t;
  -- Approving a school's owner also opens the school.
  if t.is_owner and new_status = 'active' then update schools set status = 'active' where id = t.school_id and status = 'pending'; end if;
  perform audit(case new_status when 'active' then 'Account approved / activated' when 'suspended' then 'Account suspended'
                when 'deactivated' then 'Account deactivated' else 'Account set to pending' end,
                t.name || ' (' || t.role || ')' || coalesce(' — ' || reason, ''), t.school_id);
  return t;
end $$;

create or replace function skuuulline.delete_account(target uuid) returns void
language plpgsql security definer set search_path = skuuulline as $$
declare t profiles; elsewhere boolean := false;
begin
  select * into t from profiles where user_id = target;
  perform assert_can_manage(t);
  if t.role = 'superadmin' and not exists (select 1 from profiles where role = 'superadmin' and user_id <> target) then
    raise exception 'The last Super Admin cannot be deleted';
  end if;
  if t.is_owner then update schools set owner_id = null where owner_id = target; end if;
  delete from profiles where user_id = target;
  -- The sign-in is shared with other apps on this server; remove it only if nothing else uses it.
  if to_regclass('public.profiles') is not null then
    execute 'select exists (select 1 from public.profiles where id = $1)' into elsewhere using target;
  end if;
  if not elsewhere then delete from auth.users where id = target; end if;
  perform audit('Account deleted', t.name || ' (' || t.role || coalesce(', ' || t.email, '') || ')', t.school_id);
end $$;

create or replace function skuuulline.set_school_status(sid uuid, new_status text, reason text default null) returns skuuulline.schools
language plpgsql security definer set search_path = skuuulline as $$
declare s schools;
begin
  if not is_super() then raise exception 'Only the Super Admin can do this'; end if;
  if new_status not in ('pending', 'active', 'suspended') then raise exception 'Unknown status'; end if;
  update schools set status = new_status, status_reason = reason where id = sid returning * into s;
  if s.id is null then raise exception 'School not found'; end if;
  if new_status = 'active' then
    update profiles set status = 'active', approved_by = auth.uid(), approved_at = coalesce(approved_at, now())
    where user_id = s.owner_id and status = 'pending';
  end if;
  perform audit('School ' || case new_status when 'active' then 'approved / activated' else new_status end, s.name || coalesce(' — ' || reason, ''), sid);
  return s;
end $$;

create or replace function skuuulline.delete_school(sid uuid) returns void
language plpgsql security definer set search_path = skuuulline as $$
declare s schools; u uuid; elsewhere boolean;
begin
  if not is_super() then raise exception 'Only the Super Admin can do this'; end if;
  select * into s from schools where id = sid;
  if s.id is null then raise exception 'School not found'; end if;
  for u in select user_id from profiles where school_id = sid loop
    elsewhere := false;
    if to_regclass('public.profiles') is not null then
      execute 'select exists (select 1 from public.profiles where id = $1)' into elsewhere using u;
    end if;
    delete from profiles where user_id = u;
    if not elsewhere then delete from auth.users where id = u; end if;
  end loop;
  delete from schools where id = sid;
  perform audit('School deleted', s.name);
end $$;

-- ---------------------------------------------------------------- school settings (Owner/Admin)
create or replace function skuuulline.save_school_settings(patch jsonb) returns jsonb
language plpgsql security definer set search_path = skuuulline as $$
declare sid uuid := my_school(); out jsonb;
begin
  if sid is null or not is_school_admin(sid) then raise exception 'Only the school Owner/Admin can change school settings'; end if;
  if length(coalesce(patch->>'logo', '')) > 400000 then raise exception 'The logo is too large'; end if;
  update schools set settings = settings || patch,
    name = coalesce(nullif(trim(patch->>'schoolName'), ''), name),
    phone = coalesce(patch->>'phone', phone), email = coalesce(patch->>'email', email)
  where id = sid returning settings into out;
  return out;
end $$;

create or replace function skuuulline.regenerate_code() returns text
language plpgsql security definer set search_path = skuuulline as $$
declare sid uuid := my_school(); c text;
begin
  if sid is null or not is_school_admin(sid) then raise exception 'Only the school Owner/Admin can do this'; end if;
  c := new_code();
  update schools set code = c where id = sid;
  perform audit('School code changed', null, sid);
  return c;
end $$;

-- Names and roles of staff, for parents and students (no salaries, bank or contact details).
create or replace function skuuulline.staff_directory() returns jsonb language sql stable security definer set search_path = skuuulline as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'title', data->>'title', 'firstName', data->>'firstName',
         'lastName', data->>'lastName', 'role', data->>'role', 'department', data->>'department', 'gender', data->>'gender')), '[]')
  from records where school_id = my_school() and col = 'staff';
$$;

-- Platform overview for the Super Admin.
create or replace function skuuulline.platform_stats() returns jsonb language plpgsql stable security definer set search_path = skuuulline as $$
begin
  if not is_super() then raise exception 'Only the Super Admin can do this'; end if;
  return jsonb_build_object(
    'schools', (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'students',
                  (select count(*) from records r where r.school_id = s.id and r.col = 'students'),
                  'accounts', (select count(*) from profiles p where p.school_id = s.id))), '[]') from schools s));
end $$;

revoke execute on all functions in schema skuuulline from public;
grant execute on all functions in schema skuuulline to authenticated;
grant execute on function skuuulline.school_by_code(text) to anon;

-- ---------------------------------------------------------------- realtime
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table skuuulline.records, skuuulline.profiles, skuuulline.schools;
  end if;
end $$;
alter table skuuulline.records replica identity full;
