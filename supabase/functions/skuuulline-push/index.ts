// Skuuul-Line Pro push notifications: the database hands over new skuuulline.notifications ids (pg_net, with a shared
// secret); this sends them to the recipients' phones with Firebase Cloud Messaging (HTTP v1).
// Needs the secret FIREBASE_SERVICE_ACCOUNT (the Firebase service-account JSON). Without it nothing is sent,
// but notifications are still stored (the apps show them in their notification list).
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { db: { schema: 'skuuulline' } });
const SA = (() => {
  try {
    return JSON.parse(Deno.env.get('FIREBASE_SERVICE_ACCOUNT') ?? 'null');
  } catch {
    return null;
  }
})();

const b64url = (buf: ArrayBuffer | Uint8Array | string) => {
  const bytes = typeof buf === 'string' ? new TextEncoder().encode(buf) : new Uint8Array(buf as ArrayBuffer);
  let s = '';
  bytes.forEach((b) => (s += String.fromCharCode(b)));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

let cached: { token: string; exp: number } | null = null;
async function accessToken() {
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;
  const pem = String(SA.private_key).replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: SA.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const sig = b64url(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${head}.${claims}`)));
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claims}.${sig}` }),
  });
  const j = await res.json();
  if (!j.access_token) throw new Error(`Google token: ${JSON.stringify(j).slice(0, 200)}`);
  cached = { token: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 };
  return cached.token;
}

// Bus alerts go to a spoken channel when the phone installed a voice: the phone built one Android channel per
// clip from the Record Studio's published clips (v_<clip>_<lang>_<rev>), each playing that recording.
// Everything else uses the normal 'school' channel.
const SPOKEN = ['bus_left', 'bus_board', 'bus_near', 'bus_drop'];
type Voice = { voice: string | null; voice_rev: number | null };
function channelFor(n: Record<string, string | null>, v: Voice | undefined) {
  if (!v?.voice || !v.voice_rev || !SPOKEN.includes(n.kind ?? '')) return 'school';
  const clip = n.kind === 'bus_drop' && / arrived at school$/.test(n.title ?? '') ? 'bus_arrived' : n.kind;
  return `v_${clip}_${v.voice}_${v.voice_rev}`;
}

async function send(token: string, n: Record<string, string | null>, voice?: Voice) {
  const channel = channelFor(n, voice);
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${SA.project_id}/messages:send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        token,
        notification: { title: n.title, body: n.body ?? '' },
        data: { link: n.link ?? '/', kind: n.kind ?? '', id: String(n.id) },
        android: { priority: 'HIGH', notification: { channel_id: channel, sound: 'default', default_vibrate_timings: true } },
      },
    }),
  });
  if (res.ok) return 'ok';
  const j = await res.json().catch(() => ({}));
  const code = j?.error?.details?.find?.((d: { errorCode?: string }) => d.errorCode)?.errorCode || j?.error?.status;
  return code === 'UNREGISTERED' || code === 'INVALID_ARGUMENT' || code === 'NOT_FOUND' ? 'dead' : `error:${code}`;
}

Deno.serve(async (req) => {
  const { data: cfg } = await db.from('config').select('push_secret').maybeSingle();
  if (!cfg || req.headers.get('x-push-secret') !== cfg.push_secret) return new Response('forbidden', { status: 403 });
  const { ids } = await req.json().catch(() => ({ ids: [] }));
  if (!Array.isArray(ids) || !ids.length) return Response.json({ ok: true, sent: 0 });
  if (!SA?.private_key) return Response.json({ ok: false, error: 'FIREBASE_SERVICE_ACCOUNT not set — stored only' });

  const { data: rows } = await db.from('notifications').select('*').in('id', ids.slice(0, 2000)).is('sent_at', null);
  const users = [...new Set((rows ?? []).map((r: { user_id: string }) => r.user_id))];
  if (!users.length) return Response.json({ ok: true, sent: 0 });
  const { data: tokens } = await db.from('push_tokens').select('token, user_id, voice, voice_rev').in('user_id', users);
  const byUser = new Map<string, string[]>();
  const voiceOf = new Map<string, Voice>();
  (tokens ?? []).forEach((t: { token: string; user_id: string } & Voice) => {
    byUser.set(t.user_id, [...(byUser.get(t.user_id) ?? []), t.token]);
    voiceOf.set(t.token, { voice: t.voice, voice_rev: t.voice_rev });
  });

  let sent = 0;
  const dead: string[] = [];
  const jobs = (rows ?? []).flatMap((n: Record<string, string>) => (byUser.get(n.user_id) ?? []).map((tok) => [n, tok] as const));
  for (let i = 0; i < jobs.length; i += 20) {
    const results = await Promise.all(jobs.slice(i, i + 20).map(([n, tok]) => send(tok, n, voiceOf.get(tok)).then((r) => [tok, r] as const)));
    results.forEach(([tok, r]) => (r === 'ok' ? sent++ : r === 'dead' && dead.push(tok)));
  }
  if (dead.length) await db.from('push_tokens').delete().in('token', dead);
  await db.from('notifications').update({ sent_at: new Date().toISOString() }).in('id', (rows ?? []).map((r: { id: number }) => r.id));
  return Response.json({ ok: true, sent, removed: dead.length });
});
