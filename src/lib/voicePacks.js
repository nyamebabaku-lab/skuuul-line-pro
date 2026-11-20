// Spoken bus-alert voices made in the Record Studio (Admin app → Super Admin).
// A "voice pack" = one language with its five clips. Published clips live in the public skuuulline-voice bucket.
import { supabase } from './supabase';

export const VOICE_BUCKET = 'skuuulline-voice';
export const CLIPS = ['bus_left', 'bus_board', 'bus_near', 'bus_drop', 'bus_arrived'];
export const CLIP_NAMES = {
  bus_left: 'Bus left school',
  bus_board: 'Child got on the bus',
  bus_near: 'Bus 5 minutes away',
  bus_drop: 'Child dropped off',
  bus_arrived: 'Child arrived at school',
};
/** What each clip says (English). Other languages say the same thing in their own words. */
export const SCRIPTS = {
  bus_left: 'The school bus has left school.',
  bus_board: 'Your child is on the bus.',
  bus_near: 'The school bus is about five minutes away.',
  bus_drop: 'Your child has been dropped off.',
  bus_arrived: 'Your child has arrived at school.',
};

const BASE = import.meta.env.VITE_SUPABASE_URL;
export const voiceUrl = (path) => (path ? `${BASE}/storage/v1/object/public/${VOICE_BUCKET}/${path}` : null);
/** Built into the app: the English clips, used in the demo and before any pack has loaded. */
export const builtInUrl = (clip) => `${import.meta.env.BASE_URL}voice/${clip}_en.mp3`;

const CACHE = 'skuuulline.voicePacks';
let packs = null;

/** Published, switched-on languages (cached on the phone for offline use). */
export async function loadPacks({ fresh = false } = {}) {
  if (packs && !fresh) return packs;
  if (!supabase) return (packs = []);
  try {
    const { data, error } = await supabase.from('voice_packs').select('lang,name,sort,rev,live,published').gt('rev', 0).eq('live', true).order('sort');
    if (error) throw error;
    packs = data || [];
    try {
      localStorage.setItem(CACHE, JSON.stringify(packs));
    } catch { /* storage full — fine */ }
  } catch {
    try {
      packs = JSON.parse(localStorage.getItem(CACHE) || '[]');
    } catch {
      packs = [];
    }
  }
  return packs;
}

export const packFor = (lang) => (packs || []).find((p) => p.lang === lang) || null;

/** Where a clip of a language can be played from. */
export function clipUrl(clip, lang) {
  const p = packFor(lang);
  if (p?.published?.[clip]) return voiceUrl(p.published[clip]);
  return lang === 'en' ? builtInUrl(clip) : null;
}
