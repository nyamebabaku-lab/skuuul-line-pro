-- Record Studio: the Super Admin records, edits and publishes the spoken bus-alert clips per language.
-- Phones download a published language and build their own Android notification channels from it, so a new
-- voice reaches parents without an app update.
--
-- voice_packs.draft     = work in progress, per clip: {raw, out, settings, updated_at}  (raw = the untouched take,
--                         out = the finished clip, settings = the studio's edit/effect settings to reopen it)
-- voice_packs.published = the clip files phones use, per clip: path in the skuuulline-voice bucket
-- voice_packs.rev       = goes up on every publish; phones name their channels v_<clip>_<lang>_<rev>

create table if not exists skuuulline.voice_packs (
  lang text primary key check (lang ~ '^[a-z]{2,3}$'),
  name text not null,
  sort int not null default 100,
  draft jsonb not null default '{}'::jsonb,
  published jsonb not null default '{}'::jsonb,
  rev int not null default 0,
  live boolean not null default true,
  published_at timestamptz,
  updated_at timestamptz not null default now()
);
alter table skuuulline.voice_packs enable row level security;
drop policy if exists voice_packs_read on skuuulline.voice_packs;
create policy voice_packs_read on skuuulline.voice_packs for select to anon, authenticated using (true);
drop policy if exists voice_packs_super on skuuulline.voice_packs;
create policy voice_packs_super on skuuulline.voice_packs for all to authenticated
  using ((select skuuulline.is_super())) with check ((select skuuulline.is_super()));
grant select on skuuulline.voice_packs to anon, authenticated;
grant insert, update, delete on skuuulline.voice_packs to authenticated;
grant all on skuuulline.voice_packs to service_role;

-- Publish: every one of the five clips must have a finished take.
create or replace function skuuulline.publish_voice(p_lang text) returns int
language plpgsql security definer set search_path = skuuulline as $$
declare
  pk voice_packs;
  clip text;
  pub jsonb := '{}'::jsonb;
begin
  if not is_super() then raise exception 'Only the Super Admin can publish voices'; end if;
  select * into pk from voice_packs where lang = p_lang for update;
  if pk is null then raise exception 'Unknown language'; end if;
  foreach clip in array array['bus_left', 'bus_board', 'bus_near', 'bus_drop', 'bus_arrived'] loop
    if coalesce(pk.draft->clip->>'out', '') = '' then raise exception 'Record and save "%" first', clip; end if;
    pub := pub || jsonb_build_object(clip, pk.draft->clip->>'out');
  end loop;
  update voice_packs set published = pub, rev = rev + 1, published_at = now(), updated_at = now() where lang = p_lang;
  return pk.rev + 1;
end $$;
revoke execute on function skuuulline.publish_voice(text) from public, anon;
grant execute on function skuuulline.publish_voice(text) to authenticated;

-- Phones now say which language AND which published version they installed (their channels carry the version).
alter table skuuulline.push_tokens add column if not exists voice_rev int;
alter table skuuulline.push_tokens drop constraint if exists push_tokens_voice_check;
alter table skuuulline.push_tokens add constraint push_tokens_voice_check check (voice is null or voice ~ '^[a-z]{2,3}$');
drop function if exists skuuulline.set_push_voice(text, text);
create or replace function skuuulline.set_push_voice(token text, voice text, rev int default null) returns void
language sql security definer set search_path = skuuulline as $$
  update push_tokens
     set voice = case when set_push_voice.voice ~ '^[a-z]{2,3}$' and set_push_voice.rev > 0 then set_push_voice.voice end,
         voice_rev = case when set_push_voice.voice ~ '^[a-z]{2,3}$' and set_push_voice.rev > 0 then set_push_voice.rev end,
         updated_at = now()
   where push_tokens.token = set_push_voice.token and user_id = auth.uid();
$$;
revoke execute on function skuuulline.set_push_voice(text, text, int) from public, anon;
grant execute on function skuuulline.set_push_voice(text, text, int) to authenticated;

-- Clip files: public to read (phones download them), only the Super Admin writes.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('skuuulline-voice', 'skuuulline-voice', true, 10485760, array['audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/ogg', 'audio/webm', 'audio/mp4', 'application/octet-stream'])
on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
drop policy if exists skuuulline_voice_write on storage.objects;
create policy skuuulline_voice_write on storage.objects for insert to authenticated
  with check (bucket_id = 'skuuulline-voice' and (select skuuulline.is_super()));
drop policy if exists skuuulline_voice_update on storage.objects;
create policy skuuulline_voice_update on storage.objects for update to authenticated
  using (bucket_id = 'skuuulline-voice' and (select skuuulline.is_super()));
drop policy if exists skuuulline_voice_delete on storage.objects;
create policy skuuulline_voice_delete on storage.objects for delete to authenticated
  using (bucket_id = 'skuuulline-voice' and (select skuuulline.is_super()));

-- The two languages to start with (English is filled with the built-in recordings; Twi waits for the studio).
insert into skuuulline.voice_packs (lang, name, sort) values ('en', 'English', 1), ('tw', 'Twi', 2) on conflict (lang) do nothing;
