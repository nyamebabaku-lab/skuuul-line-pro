-- School Owner/Admin (or the Super Admin) sets a temporary password for someone who forgot theirs.
create or replace function skuuulline.reset_member_password(target uuid, new_password text) returns void
language plpgsql security definer set search_path = skuuulline, extensions, public as $$
declare t skuuulline.profiles; shared boolean := false;
begin
  if length(coalesce(new_password, '')) < 8 or new_password !~ '\d' then raise exception 'Password needs at least 8 characters, including a number'; end if;
  select * into t from skuuulline.profiles where user_id = target;
  perform skuuulline.assert_can_manage(t);
  if to_regclass('public.profiles') is not null then
    execute 'select exists (select 1 from public.profiles where id = $1)' into shared using target;
  end if;
  if shared then raise exception 'This sign-in is also used by another app, so only its owner can change the password'; end if;
  update auth.users set encrypted_password = crypt(new_password, gen_salt('bf')), updated_at = now() where id = target;
  perform skuuulline.audit('Password reset', t.name || ' (' || t.role || ')', t.school_id);
end $$;
revoke execute on function skuuulline.reset_member_password(uuid, text) from public;
grant execute on function skuuulline.reset_member_password(uuid, text) to authenticated;
