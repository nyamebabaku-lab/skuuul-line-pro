// Spoken bus alerts. Each parent picks Off or one of the languages published from the Record Studio
// (kept on this phone / browser).
// - App closed: Android plays the clip itself. The phone downloads the language's clips and builds one notification
//   channel per clip (v_<clip>_<lang>_<rev>, see VoiceChannelsPlugin.java), then tells the server which
//   language + version it has (set_push_voice) so bus alerts are sent to those channels.
// - App open: English reads the whole message aloud (with the child's name); other languages play the clip.
import { registerPlugin } from '@capacitor/core';
import { IS_NATIVE, ADMIN_APP } from '../config';
import { supabase } from './supabase';
import { CLIPS, CLIP_NAMES, loadPacks, packFor, clipUrl, voiceUrl } from './voicePacks';

export { CLIPS, CLIP_NAMES };
const KEY = 'skuuulline.busVoice';
const VoiceChannels = registerPlugin('VoiceChannels');

/** 'off' or a language code; English unless the parent chose otherwise. */
export function getVoice() {
  try {
    return localStorage.getItem(KEY) || 'en';
  } catch {
    return 'en';
  }
}

/** Off + every published language (English is always offered: it is built into the app). */
export async function voiceChoices() {
  const list = await loadPacks();
  const langs = list.map((p) => ({ value: p.lang, label: p.name }));
  if (!langs.some((l) => l.value === 'en')) langs.unshift({ value: 'en', label: 'English' });
  return [{ value: 'off', label: 'Off (text only)' }, ...langs];
}

let pushToken = null;
let syncing = null;

/** Builds this phone's spoken channels for the chosen language and tells the server (Android app only). */
export async function syncVoice(token) {
  if (token) pushToken = token;
  if (!pushToken || !supabase || ADMIN_APP) return;
  const run = async () => {
    const lang = getVoice();
    await loadPacks({ fresh: true });
    const pack = lang === 'off' ? null : packFor(lang);
    let rev = null;
    if (pack && IS_NATIVE) {
      try {
        await VoiceChannels.install({
          channels: CLIPS.map((clip) => ({
            id: `v_${clip}_${pack.lang}_${pack.rev}`,
            name: `Bus: ${CLIP_NAMES[clip]} (${pack.name})`,
            url: voiceUrl(pack.published[clip]),
          })),
        });
        rev = pack.rev;
      } catch (e) {
        console.warn('voice channels', e);
      }
    }
    await supabase.rpc('set_push_voice', { token: pushToken, voice: rev ? pack.lang : null, rev }).catch(() => {});
  };
  syncing = (syncing || Promise.resolve()).then(run, run);
  return syncing;
}

export async function setVoice(v) {
  try {
    localStorage.setItem(KEY, v);
  } catch { /* private mode — the choice lasts until the app closes */ }
  await syncVoice();
}

/** Which recorded clip fits a notification (null = not a bus alert). */
export function clipOf(n) {
  if (!n || !['bus_left', 'bus_board', 'bus_near', 'bus_drop'].includes(n.kind)) return null;
  return n.kind === 'bus_drop' && / arrived at school$/.test(n.title || '') ? 'bus_arrived' : n.kind;
}

let audio = null;
export async function playClip(clip, lang) {
  await loadPacks();
  const url = clipUrl(clip, lang);
  if (!url) return;
  try {
    audio?.pause();
    audio = new Audio(url);
    await audio.play();
  } catch { /* autoplay blocked or offline */ }
}

/** The words read aloud in English when the app is open. */
export function sentenceOf(n) {
  const body = (n.body || '').replace(/\b(\d{1,2}):(\d{2})\b/g, (_, h, m) => `${Number(h)}:${m}`);
  return n.kind === 'bus_near' ? `${n.title}. ${body}` : body || n.title;
}

async function say(text) {
  if (IS_NATIVE) {
    const { TextToSpeech } = await import('@capacitor-community/text-to-speech');
    await TextToSpeech.stop().catch(() => {});
    await TextToSpeech.speak({ text, lang: 'en-GB', rate: 0.95, category: 'playback' });
    return;
  }
  if (!('speechSynthesis' in window)) throw new Error('no speech');
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'en-GB';
  u.rate = 0.95;
  const gb = window.speechSynthesis.getVoices().find((v) => v.lang === 'en-GB');
  if (gb) u.voice = gb;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(u);
}

/** A new notification arrived while the app is open: speak it if it is a bus alert. */
export async function speakAlert(n, voice = getVoice()) {
  const clip = clipOf(n);
  if (!clip || voice === 'off') return;
  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return; // the phone plays the clip itself
  if (voice !== 'en') return playClip(clip, voice);
  try {
    await say(sentenceOf(n)); // the full message, with the child's name and stop
  } catch {
    return playClip(clip, 'en'); // no speech engine: the recorded clip instead
  }
}
