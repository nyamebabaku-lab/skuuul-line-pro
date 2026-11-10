-- 0012: the app is now Skuuul-Line Pro. Renames the live "edunexa" schema to "skuuulline" and everything that
-- carried the old name. Safe to run more than once (does nothing once renamed). Fresh installs (0001…) already use
-- the new names, so they skip this.
do $$
declare f record; def text;
begin
  if not exists (select 1 from pg_namespace where nspname = 'edunexa') then
    raise notice 'already renamed';
    return;
  end if;
  alter schema edunexa rename to skuuulline;
  -- Function bodies and their search_path still say "edunexa": recreate each one with the new name.
  for f in select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'skuuulline' and p.prokind = 'f' loop
    def := pg_get_functiondef(f.oid);
    if position('edunexa' in def) > 0 then
      execute replace(def, 'edunexa', 'skuuulline');
    end if;
  end loop;
  -- The push dispatcher's server function has a new name.
  update skuuulline.config set push_url = replace(push_url, 'edunexa-push', 'skuuulline-push');
  -- Sign-in addresses of phone-number accounts (users never see these).
  update auth.users set email = replace(email, '@phone.edunexa.app', '@phone.skuuulline.app')
  where email like '%@phone.edunexa.app';
  update auth.identities set identity_data = jsonb_set(identity_data, '{email}', to_jsonb(replace(identity_data->>'email', '@phone.edunexa.app', '@phone.skuuulline.app')))
  where identity_data->>'email' like '%@phone.edunexa.app';
  update skuuulline.profiles set email = replace(email, '@phone.edunexa.app', '@phone.skuuulline.app')
  where email like '%@phone.edunexa.app';
end $$;
