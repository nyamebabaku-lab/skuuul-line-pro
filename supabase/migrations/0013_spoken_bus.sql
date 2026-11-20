-- Spoken bus alerts. Each phone says which voice it wants for bus alerts: 'en' (English), 'tw' (Twi) or null
-- (text only, the normal notification sound). Phones on older app versions never set it, so they keep getting
-- the plain alert. The push function picks the matching Android channel (each channel plays its own recorded clip).

alter table skuuulline.push_tokens add column if not exists voice text;
alter table skuuulline.push_tokens drop constraint if exists push_tokens_voice_check;
alter table skuuulline.push_tokens add constraint push_tokens_voice_check check (voice is null or voice in ('en', 'tw'));

create or replace function skuuulline.set_push_voice(token text, voice text) returns void
language sql security definer set search_path = skuuulline as $$
  update push_tokens set voice = case when set_push_voice.voice in ('en', 'tw') then set_push_voice.voice end, updated_at = now()
  where push_tokens.token = set_push_voice.token and user_id = auth.uid();
$$;
revoke execute on function skuuulline.set_push_voice(text, text) from public, anon;
grant execute on function skuuulline.set_push_voice(text, text) to authenticated;
