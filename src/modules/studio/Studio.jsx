// Record Studio (Super Admin): record the spoken bus alerts in any language, edit, clean up, polish, add effects,
// mix with a chime or music, then publish — parents' phones download the new voice on their next open.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Mic, Square, Upload, Play, Pause, Undo2, Redo2, Scissors, Crop, VolumeX, Volume2, Volume1, ArrowLeft, Save, Download, Send, Plus,
  Sparkles, Wand2, Music, SlidersHorizontal, CheckCircle2, Radio, Languages, Loader2, Eye, EyeOff,
} from 'lucide-react';
import { supabase, must } from '../../lib/supabase';
import { VOICE_BUCKET, CLIPS, CLIP_NAMES, SCRIPTS, voiceUrl } from '../../lib/voicePacks';
import { Card, CardHeader, PageHeader, Badge, Button, Modal, Field, Input, Select, Tabs, toast, confirmDialog, cx, EmptyState } from '../../components/ui';
import Waveform from './Waveform';
import {
  SR, decodeToMono, processTake, encodeWav, merge, withPreset, PRESETS, CHIMES, BEDS, joinCrossfade, trimSilence, lin2db,
} from './engine';

const MAX_SECONDS = 30;
const fmtSec = (s) => `${(s || 0).toFixed(1)} s`;

// ---------------------------------------------------------------- playback (one shared AudioContext)
let actx = null;
const ac = () => (actx ||= new (window.AudioContext || window.webkitAudioContext)());

function usePlayer() {
  const [state, setState] = useState({ playing: null, at: null });
  const src = useRef(null);
  const raf = useRef(0);
  const stop = useCallback(() => {
    try {
      src.current?.stop();
    } catch { /* already stopped */ }
    src.current = null;
    cancelAnimationFrame(raf.current);
    setState({ playing: null, at: null });
  }, []);
  const play = useCallback(
    (key, samples, from = 0, to = null) => {
      stop();
      if (!samples?.length) return;
      const ctx = ac();
      ctx.resume();
      const b = ctx.createBuffer(1, samples.length, SR);
      b.getChannelData(0).set(samples);
      const s = ctx.createBufferSource();
      s.buffer = b;
      s.connect(ctx.destination);
      const end = to ?? samples.length / SR;
      s.start(0, from, Math.max(0.01, end - from));
      const t0 = ctx.currentTime;
      src.current = s;
      s.onended = () => src.current === s && stop();
      const tick = () => {
        setState({ playing: key, at: from + (ctx.currentTime - t0) });
        raf.current = requestAnimationFrame(tick);
      };
      tick();
    },
    [stop],
  );
  useEffect(() => stop, [stop]);
  return { ...state, play, stop };
}

// ---------------------------------------------------------------- small controls
function Slider({ label, value, min, max, step = 0.01, onChange, fmt = (v) => v, hint }) {
  return (
    <label className="block">
      <span className="flex items-center justify-between text-xs font-semibold text-slate-600 dark:text-slate-300">
        <span>{label}</span>
        <span className="font-mono text-slate-500">{fmt(value)}</span>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="mt-1.5 w-full accent-brand-600" />
      {hint && <span className="block text-[11px] text-slate-400">{hint}</span>}
    </label>
  );
}

function Toggle({ label, checked, onChange, hint }) {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 h-4 w-4 accent-brand-600" />
      <span>
        <span className="block text-sm font-semibold text-slate-700 dark:text-slate-200">{label}</span>
        {hint && <span className="block text-xs text-slate-500">{hint}</span>}
      </span>
    </label>
  );
}

const dB = (v) => `${v > 0 ? '+' : ''}${Number(v).toFixed(1)} dB`;
const pct = (v) => `${Math.round(v * 100)}%`;

// ---------------------------------------------------------------- the editor for one clip
function Editor({ pack, clip, onClose, onSaved }) {
  const draft = pack.draft?.[clip] || {};
  const [take, setTake] = useState(null); // edited voice take (Float32Array)
  const [history, setHistory] = useState({ past: [], future: [] });
  const [rawBlob, setRawBlob] = useState(null); // a new source recording/upload to keep
  const [settings, setSettings] = useState(() => merge(draft.settings));
  const [music, setMusic] = useState(null); // { samples, blob?, path? }
  const [result, setResult] = useState(null);
  const [step, setStep] = useState('');
  const [sel, setSel] = useState(null);
  const [tab, setTab] = useState('clean');
  const [loading, setLoading] = useState(!!draft.take);
  const [saving, setSaving] = useState(false);
  const [rec, setRec] = useState(null); // { phase: 'count'|'rec', n, secs, level }
  const recRef = useRef(null);
  const player = usePlayer();
  const fileIn = useRef(null);
  const musicIn = useRef(null);
  const dirty = useRef(false);

  // Reopen the saved take and its music
  useEffect(() => {
    let on = true;
    (async () => {
      try {
        if (draft.take) {
          const ab = await (await fetch(voiceUrl(draft.take))).arrayBuffer();
          const x = await decodeToMono(ab);
          if (on) setTake(x);
        }
        if (draft.music) {
          const ab = await (await fetch(voiceUrl(draft.music))).arrayBuffer();
          const m = await decodeToMono(ab);
          if (on) setMusic({ samples: m, path: draft.music });
        }
      } catch (e) {
        toast.error('Could not open the saved recording', e.message);
      } finally {
        if (on) setLoading(false);
      }
    })();
    return () => {
      on = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-process whenever the take or the settings change (debounced; stale results are dropped)
  const job = useRef(0);
  useEffect(() => {
    if (!take?.length) {
      setResult(null);
      return undefined;
    }
    const id = ++job.current;
    const t = setTimeout(async () => {
      try {
        const r = await processTake(take, settings, { music: music?.samples, onStep: (s) => id === job.current && setStep(s) });
        if (id === job.current) {
          setResult(r);
          setStep('');
        }
      } catch (e) {
        if (id === job.current) {
          setStep('');
          toast.error('Processing failed', e.message);
        }
      }
    }, 350);
    return () => clearTimeout(t);
  }, [take, settings, music]);

  const set = (group, patch) => {
    dirty.current = true;
    setSettings((s) => ({ ...s, [group]: { ...s[group], ...patch } }));
  };

  const edit = (next) => {
    dirty.current = true;
    setHistory((h) => ({ past: [...h.past.slice(-29), take], future: [] }));
    setTake(next);
    setSel(null);
  };
  const undo = () => {
    if (!history.past.length) return;
    setHistory((h) => ({ past: h.past.slice(0, -1), future: [take, ...h.future] }));
    setTake(history.past[history.past.length - 1]);
    setSel(null);
  };
  const redo = () => {
    if (!history.future.length) return;
    setHistory((h) => ({ past: [...h.past, take], future: h.future.slice(1) }));
    setTake(history.future[0]);
    setSel(null);
  };
  const range = () => (sel ? [Math.floor(sel[0] * SR), Math.min(take.length, Math.ceil(sel[1] * SR))] : null);
  const cut = () => {
    const [a, b] = range();
    edit(joinCrossfade([take.slice(0, a), take.slice(b)]));
  };
  const crop = () => {
    const [a, b] = range();
    edit(take.slice(a, b));
  };
  const gainSel = (g) => {
    const [a, b] = range();
    const y = new Float32Array(take);
    const f = Math.min(Math.round(0.01 * SR), Math.floor((b - a) / 4));
    for (let i = a; i < b; i++) {
      const edge = Math.min(1, (i - a) / (f || 1), (b - 1 - i) / (f || 1));
      y[i] *= 1 + (g - 1) * edge;
    }
    edit(y);
  };

  const newSource = async (blob) => {
    const x = await decodeToMono(await blob.arrayBuffer());
    if (x.length / SR > MAX_SECONDS + 5) throw new Error(`Keep it under ${MAX_SECONDS} seconds`);
    if (take) setHistory((h) => ({ past: [...h.past.slice(-29), take], future: [] }));
    setRawBlob(blob);
    setTake(x);
    setSel(null);
    dirty.current = true;
  };

  // ---- recording: 3-2-1 count-in, level meter, auto-stop at MAX_SECONDS
  const startRec = async () => {
    player.stop();
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true, channelCount: 1 } });
    } catch {
      toast.error('Microphone blocked', 'Allow the microphone for this app, then try again.');
      return;
    }
    const ctx = ac();
    await ctx.resume();
    const an = ctx.createAnalyser();
    an.fftSize = 1024;
    const srcNode = ctx.createMediaStreamSource(stream);
    srcNode.connect(an);
    const r = { stream, an, srcNode, chunks: [], timer: 0, raf: 0, cancelled: false };
    recRef.current = r;
    for (let n = 3; n > 0; n--) {
      setRec({ phase: 'count', n });
      // soft count-in click
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = n === 1 ? 1320 : 880;
      g.gain.setValueAtTime(0.15, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12);
      o.connect(g).connect(ctx.destination);
      o.start();
      o.stop(ctx.currentTime + 0.13);
      await new Promise((res) => setTimeout(res, 800));
      if (r.cancelled) return;
    }
    const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find((t) => window.MediaRecorder?.isTypeSupported?.(t)) || '';
    const mr = new MediaRecorder(stream, type ? { mimeType: type, audioBitsPerSecond: 128000 } : undefined);
    r.mr = mr;
    mr.ondataavailable = (e) => e.data.size && r.chunks.push(e.data);
    mr.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      srcNode.disconnect();
      cancelAnimationFrame(r.raf);
      clearInterval(r.timer);
      setRec(null);
      if (r.cancelled || !r.chunks.length) return;
      try {
        await newSource(new Blob(r.chunks, { type: mr.mimeType || 'audio/webm' }));
      } catch (e) {
        toast.error('Could not use the recording', e.message);
      }
    };
    mr.start(250);
    const t0 = Date.now();
    const buf = new Float32Array(an.fftSize);
    const meter = () => {
      an.getFloatTimeDomainData(buf);
      let p = 0;
      for (let i = 0; i < buf.length; i++) p = Math.max(p, Math.abs(buf[i]));
      setRec((s) => (s ? { ...s, level: p } : s));
      r.raf = requestAnimationFrame(meter);
    };
    setRec({ phase: 'rec', secs: 0, level: 0 });
    meter();
    r.timer = setInterval(() => {
      const secs = (Date.now() - t0) / 1000;
      setRec((s) => (s ? { ...s, secs } : s));
      if (secs >= MAX_SECONDS) mr.state === 'recording' && mr.stop();
    }, 100);
  };
  const stopRec = () => {
    const r = recRef.current;
    if (!r) return;
    if (r.mr?.state === 'recording') r.mr.stop();
    else {
      r.cancelled = true;
      r.stream.getTracks().forEach((t) => t.stop());
      setRec(null);
    }
  };
  useEffect(() => () => {
    const r = recRef.current;
    if (r) {
      r.cancelled = true;
      r.mr?.state === 'recording' && r.mr.stop();
      r.stream?.getTracks().forEach((t) => t.stop());
    }
  }, []);

  const pickFile = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    try {
      await newSource(f);
    } catch (err) {
      toast.error('Could not open that file', err.message || 'Use an audio file (mp3, m4a, wav, ogg, opus).');
    }
  };
  const pickMusic = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    try {
      const m = await decodeToMono(await f.arrayBuffer());
      setMusic({ samples: m, blob: f });
      set('mix', { bed: 'upload' });
    } catch {
      toast.error('Could not open that music file');
    }
  };

  // ---- save: original take, edited take, finished clip and settings
  const save = async () => {
    if (!result?.out?.length) return;
    setSaving(true);
    try {
      const store = supabase.storage.from(VOICE_BUCKET);
      const base = `${pack.lang}/${clip}/${Date.now()}`;
      const up = async (path, blob, type) => {
        const { error } = await store.upload(path, blob, { contentType: type, upsert: false, cacheControl: '31536000' });
        if (error) throw new Error(error.message);
        return path;
      };
      const next = { ...draft };
      if (rawBlob) {
        const ext = (rawBlob.type.split('/')[1] || 'webm').split(';')[0].replace('mpeg', 'mp3').replace('x-m4a', 'm4a');
        next.raw = await up(`${base}-raw.${ext}`, rawBlob, rawBlob.type || 'application/octet-stream');
      }
      next.take = await up(`${base}-take.wav`, encodeWav(take), 'audio/wav');
      next.out = await up(`${base}.wav`, encodeWav(result.out), 'audio/wav');
      if (music?.blob) next.music = await up(`${base}-music.${(music.blob.name.split('.').pop() || 'mp3').toLowerCase()}`, music.blob, music.blob.type || 'audio/mpeg');
      else if (music?.path) next.music = music.path;
      next.settings = settings;
      next.seconds = Number(result.seconds.toFixed(2));
      next.lufs = Number(result.loudness.toFixed(1));
      next.updated_at = new Date().toISOString();
      const { data: row } = await supabase.from('voice_packs').select('draft').eq('lang', pack.lang).single();
      must(await supabase.from('voice_packs').update({ draft: { ...(row?.draft || {}), [clip]: next }, updated_at: new Date().toISOString() }).eq('lang', pack.lang));
      dirty.current = false;
      toast.success('Saved', `${CLIP_NAMES[clip]} (${pack.name}) — publish when all five are ready.`);
      onSaved();
    } catch (e) {
      toast.error('Could not save', e.message);
    } finally {
      setSaving(false);
    }
  };

  const close = async () => {
    if (dirty.current && !(await confirmDialog('Leave without saving?', 'Your changes to this clip will be lost.', { confirmLabel: 'Leave' }))) return;
    player.stop();
    onClose();
  };

  const download = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(encodeWav(result.out));
    a.download = `${clip}_${pack.lang}.wav`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  };

  const s = settings;
  const takeSecs = take ? take.length / SR : 0;
  const busy = !!step;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="secondary" icon={ArrowLeft} onClick={close}>All clips</Button>
        <div className="order-last min-w-0 basis-full sm:order-none sm:basis-0 sm:flex-1">
          <p className="text-lg font-extrabold text-slate-900 dark:text-white">{CLIP_NAMES[clip]} · {pack.name}</p>
          <p className="text-xs text-slate-500">Saved clips go live only when you press Publish.</p>
        </div>
        <Button className="ml-auto sm:ml-0" icon={saving ? Loader2 : Save} disabled={!result || saving || busy} onClick={save}>{saving ? 'Saving…' : 'Save clip'}</Button>
      </div>

      {/* 1. Script + record */}
      <Card className="overflow-hidden">
        <div className="bg-gradient-to-r from-brand-700 to-brand-600 p-5 text-white">
          <p className="text-xs font-semibold uppercase tracking-wider text-white/70">{pack.lang === 'en' ? 'Say' : `Say this in ${pack.name}`}</p>
          <p className="mt-1 text-2xl font-extrabold leading-snug sm:text-3xl">“{SCRIPTS[clip]}”</p>
          <p className="mt-2 text-xs text-white/75">Speak clearly and a little slower than normal, about a hand's width from the phone. Quiet room, no fan.</p>
        </div>
        <div className="flex flex-wrap items-center gap-3 p-5">
          {!rec ? (
            <>
              <Button icon={Mic} onClick={startRec}>{take ? 'Record again' : 'Record'}</Button>
              <Button variant="secondary" icon={Upload} onClick={() => fileIn.current?.click()}>Upload a recording</Button>
              <input ref={fileIn} type="file" accept="audio/*,.opus,.m4a,.ogg,.wav,.mp3,.aac,.amr" className="hidden" onChange={pickFile} />
              <span className="text-xs text-slate-500">A WhatsApp voice note works too.</span>
            </>
          ) : rec.phase === 'count' ? (
            <div className="flex items-center gap-4">
              <span className="flex h-14 w-14 items-center justify-center rounded-full bg-accent-600 text-2xl font-extrabold text-white">{rec.n}</span>
              <span className="text-sm font-semibold text-slate-600 dark:text-slate-300">Get ready…</span>
              <Button variant="secondary" onClick={stopRec}>Cancel</Button>
            </div>
          ) : (
            <div className="flex w-full flex-wrap items-center gap-4">
              <span className="relative flex h-3 w-3"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent-500 opacity-75" /><span className="relative inline-flex h-3 w-3 rounded-full bg-accent-600" /></span>
              <span className="font-mono text-lg font-bold text-slate-900 dark:text-white">{rec.secs.toFixed(1)}s</span>
              <div className="h-3 min-w-[120px] flex-1 overflow-hidden rounded-full bg-slate-100 dark:bg-white/10" aria-label="Microphone level">
                <div className={cx('h-full rounded-full transition-[width] duration-75', rec.level > 0.95 ? 'bg-accent-600' : rec.level > 0.6 ? 'bg-amber-500' : 'bg-emerald-500')} style={{ width: `${Math.min(100, Math.max(2, (lin2db(rec.level) + 60) * (100 / 60)))}%` }} />
              </div>
              <Button icon={Square} onClick={stopRec}>Stop</Button>
              {rec.level > 0.95 && <span className="w-full text-xs font-semibold text-accent-600">Too loud — move the phone a little further away.</span>}
            </div>
          )}
        </div>
      </Card>

      {loading ? (
        <Card className="p-10 text-center text-sm text-slate-500"><Loader2 className="mx-auto mb-2 h-5 w-5 animate-spin" /> Opening the saved recording…</Card>
      ) : !take ? (
        <Card><EmptyState icon={Mic} title="Record or upload the line above" text="Then cut out mistakes, clean it up, polish it and add effects here." /></Card>
      ) : (
        <>
          {/* 2. Edit */}
          <Card>
            <CardHeader title="Edit" subtitle="Drag across the waveform to select part of the recording" icon={Scissors} />
            <div className="space-y-3 p-5 pt-3">
              <Waveform samples={take} selection={sel} onSelect={setSel} playhead={player.playing === 'take' ? player.at : null} />
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="secondary" icon={player.playing === 'take' ? Pause : Play} onClick={() => (player.playing === 'take' ? player.stop() : player.play('take', take, sel?.[0] || 0, sel?.[1] ?? null))}>
                  {sel ? 'Play selection' : 'Play'}
                </Button>
                <Button size="sm" variant="secondary" icon={Scissors} disabled={!sel} onClick={cut}>Delete</Button>
                <Button size="sm" variant="secondary" icon={Crop} disabled={!sel} onClick={crop}>Keep only this</Button>
                <Button size="sm" variant="secondary" icon={VolumeX} disabled={!sel} onClick={() => gainSel(0)}>Silence</Button>
                <Button size="sm" variant="secondary" icon={Volume2} disabled={!sel} onClick={() => gainSel(1.41)}>Louder</Button>
                <Button size="sm" variant="secondary" icon={Volume1} disabled={!sel} onClick={() => gainSel(0.71)}>Softer</Button>
                <Button size="sm" variant="secondary" icon={Wand2} onClick={() => edit(trimSilence(take))}>Trim ends</Button>
                <span className="mx-1 hidden h-6 w-px bg-slate-200 dark:bg-white/10 sm:block" />
                <Button size="sm" variant="ghost" icon={Undo2} disabled={!history.past.length} onClick={undo}>Undo</Button>
                <Button size="sm" variant="ghost" icon={Redo2} disabled={!history.future.length} onClick={redo}>Redo</Button>
                <span className="ml-auto text-xs text-slate-500">{sel ? `${fmtSec(sel[1] - sel[0])} selected · ` : ''}{fmtSec(takeSecs)}</span>
              </div>
            </div>
          </Card>

          {/* 3. Sound */}
          <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1.1fr_1fr]">
            <Card>
              <CardHeader title="Sound" subtitle="Changes are applied as you go" icon={SlidersHorizontal} />
              <div className="p-5 pt-3">
                <Tabs
                  value={tab}
                  onChange={setTab}
                  tabs={[
                    { value: 'clean', label: 'Clean-up' },
                    { value: 'polish', label: 'Polish' },
                    { value: 'fx', label: 'Effects' },
                    { value: 'mix', label: 'Mix' },
                  ]}
                />
                <div className="mt-4 space-y-4">
                  {tab === 'clean' && (
                    <>
                      <Slider label="Noise removal" value={s.clean.noise} min={0} max={1} onChange={(v) => set('clean', { noise: v })} fmt={(v) => (v ? pct(v) : 'Off')} hint="Takes out hiss, fans and room noise. Too high can sound watery." />
                      <Slider label="Rumble filter" value={s.clean.highpass} min={0} max={200} step={5} onChange={(v) => set('clean', { highpass: v })} fmt={(v) => (v ? `${v} Hz` : 'Off')} hint="Removes traffic and handling rumble below this pitch." />
                      <Toggle label="Remove electrical hum (50 Hz)" checked={s.clean.hum} onChange={(v) => set('clean', { hum: v })} hint="The buzz from mains power and generators." />
                      <Toggle label="Trim silence at the start and end" checked={s.clean.trim} onChange={(v) => set('clean', { trim: v })} />
                      <Toggle label="Shorten long pauses" checked={s.clean.pauses} onChange={(v) => set('clean', { pauses: v })} hint="Any gap longer than 0.3 s inside the line is tightened." />
                    </>
                  )}
                  {tab === 'polish' && (
                    <>
                      <Field label="Preset">
                        <Select value={s.polish.preset} onChange={(e) => (dirty.current = true, setSettings((x) => withPreset(x, e.target.value)))} options={Object.entries(PRESETS).map(([value, p]) => ({ value, label: p.label }))} />
                      </Field>
                      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                        <Slider label="Bass (warmth)" value={s.polish.bass} min={-6} max={6} step={0.5} onChange={(v) => set('polish', { bass: v })} fmt={dB} />
                        <Slider label="Mud (boxy sound)" value={s.polish.mid} min={-6} max={6} step={0.5} onChange={(v) => set('polish', { mid: v })} fmt={dB} />
                        <Slider label="Presence (clear words)" value={s.polish.presence} min={-6} max={8} step={0.5} onChange={(v) => set('polish', { presence: v })} fmt={dB} />
                        <Slider label="Air (sparkle)" value={s.polish.air} min={-6} max={6} step={0.5} onChange={(v) => set('polish', { air: v })} fmt={dB} />
                      </div>
                      <Slider label="Compressor" value={s.polish.comp} min={0} max={1} onChange={(v) => set('polish', { comp: v })} fmt={(v) => (v ? pct(v) : 'Off')} hint="Evens out loud and soft words so every word is heard." />
                      <Toggle label="Even loudness (master)" checked={s.polish.loud} onChange={(v) => set('polish', { loud: v })} hint="Makes every clip equally loud, and never distorted." />
                      {s.polish.loud && <Slider label="Loudness target" value={s.polish.target} min={-23} max={-11} step={0.5} onChange={(v) => set('polish', { target: v })} fmt={(v) => `${v} LUFS`} hint="-16 is right for phone alerts. Higher = louder." />}
                    </>
                  )}
                  {tab === 'fx' && (
                    <>
                      <Field label="Reverb (room sound)">
                        <Select value={s.fx.reverb} onChange={(e) => set('fx', { reverb: e.target.value })} options={[{ value: 'none', label: 'None (dry)' }, { value: 'studio', label: 'Studio' }, { value: 'room', label: 'Room' }, { value: 'plate', label: 'Plate' }, { value: 'hall', label: 'Hall' }]} />
                      </Field>
                      {s.fx.reverb !== 'none' && <Slider label="Reverb amount" value={s.fx.reverbMix} min={0.02} max={0.5} onChange={(v) => set('fx', { reverbMix: v })} fmt={pct} />}
                      <Slider label="Pitch" value={s.fx.pitch} min={-4} max={4} step={0.5} onChange={(v) => set('fx', { pitch: v })} fmt={(v) => (v ? `${v > 0 ? '+' : ''}${v} semitones` : 'As recorded')} hint="Deeper or higher voice, same speed." />
                      <Slider label="Speed" value={s.fx.speed} min={0.8} max={1.25} step={0.01} onChange={(v) => set('fx', { speed: v })} fmt={(v) => (Math.abs(v - 1) < 0.005 ? 'As recorded' : `${Math.round(v * 100)}%`)} hint="Slower or faster, same pitch." />
                      <div className="grid grid-cols-2 gap-4">
                        <Slider label="Fade in" value={s.fx.fadeIn} min={0} max={500} step={5} onChange={(v) => set('fx', { fadeIn: v })} fmt={(v) => `${v} ms`} />
                        <Slider label="Fade out" value={s.fx.fadeOut} min={0} max={1000} step={10} onChange={(v) => set('fx', { fadeOut: v })} fmt={(v) => `${v} ms`} />
                      </div>
                    </>
                  )}
                  {tab === 'mix' && (
                    <>
                      <Field label="Chime before the voice">
                        <Select value={s.mix.chime} onChange={(e) => set('mix', { chime: e.target.value })} options={Object.entries(CHIMES).map(([value, label]) => ({ value, label }))} />
                      </Field>
                      {s.mix.chime !== 'none' && (
                        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                          <Slider label="Chime volume" value={s.mix.chimeVol} min={0.1} max={1} onChange={(v) => set('mix', { chimeVol: v })} fmt={pct} />
                          <Slider label="Gap before voice" value={s.mix.gap} min={0} max={0.5} step={0.01} onChange={(v) => set('mix', { gap: v })} fmt={(v) => `${v.toFixed(2)} s`} />
                        </div>
                      )}
                      <Field label="Music under the voice">
                        <Select value={s.mix.bed} onChange={(e) => (e.target.value === 'upload' && !music ? musicIn.current?.click() : set('mix', { bed: e.target.value }))} options={Object.entries(BEDS).map(([value, label]) => ({ value, label }))} />
                      </Field>
                      <input ref={musicIn} type="file" accept="audio/*" className="hidden" onChange={pickMusic} />
                      {s.mix.bed === 'upload' && <Button size="sm" variant="secondary" icon={Music} onClick={() => musicIn.current?.click()}>{music ? 'Change music file' : 'Choose music file'}</Button>}
                      {s.mix.bed !== 'none' && <Slider label="Music volume" value={s.mix.bedVol} min={0.02} max={0.4} onChange={(v) => set('mix', { bedVol: v })} fmt={pct} hint="Keep it low so the words stay clear." />}
                    </>
                  )}
                </div>
              </div>
            </Card>

            {/* 4. Result + A/B */}
            <Card>
              <CardHeader title="Finished clip" subtitle="What parents will hear" icon={Sparkles} action={busy ? <Badge tone="blue">{step}…</Badge> : result ? <Badge tone="green">Ready</Badge> : null} />
              <div className="space-y-4 p-5 pt-3">
                <div className={cx('transition-opacity', busy && 'opacity-50')}>
                  <Waveform samples={result?.out} interactive={false} height={110} tone="green" playhead={player.playing === 'out' ? player.at : null} marker={result?.voiceStart || null} />
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button icon={player.playing === 'out' ? Pause : Play} disabled={!result} onClick={() => (player.playing === 'out' ? player.stop() : player.play('out', result.out))}>
                    {player.playing === 'out' ? 'Stop' : 'Play finished'}
                  </Button>
                  <Button variant="secondary" icon={player.playing === 'take' ? Pause : Play} onClick={() => (player.playing === 'take' ? player.stop() : player.play('take', take))}>Original</Button>
                  <Button variant="ghost" icon={Download} disabled={!result} onClick={download}>WAV</Button>
                </div>
                {result && (
                  <div className="grid grid-cols-3 gap-3 text-center">
                    {[
                      ['Length', fmtSec(result.seconds)],
                      ['Loudness', `${result.loudness.toFixed(1)} LUFS`],
                      ['Peak', `${result.peakDb.toFixed(1)} dB`],
                    ].map(([k, v]) => (
                      <div key={k} className="rounded-xl bg-slate-50 p-3 dark:bg-white/5">
                        <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">{k}</p>
                        <p className="mt-0.5 font-mono text-sm font-bold text-slate-900 dark:text-white">{v}</p>
                      </div>
                    ))}
                  </div>
                )}
                {result && result.seconds > 8 && <p className="text-xs font-semibold text-amber-600">Phone alerts work best under 6 seconds. Try cutting pauses or speeding up a little.</p>}
              </div>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- languages + clips overview
function AddLanguage({ open, onClose, onAdded, existing }) {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const SUGGEST = [['Ga', 'gaa'], ['Ewe', 'ee'], ['Fante', 'fat'], ['Hausa', 'ha'], ['Dagbani', 'dag'], ['Nzema', 'nzi'], ['French', 'fr']].filter(([, c]) => !existing.includes(c));
  const add = async () => {
    const c = code.trim().toLowerCase();
    if (!name.trim() || !/^[a-z]{2,3}$/.test(c)) return toast.error('Name and a 2–3 letter code are needed', 'e.g. Ga → gaa, Ewe → ee');
    if (existing.includes(c)) return toast.error('That language is already there');
    try {
      must(await supabase.from('voice_packs').insert({ lang: c, name: name.trim(), sort: 10 + existing.length }));
      toast.success(`${name.trim()} added`, 'Record its five clips, then publish.');
      setName('');
      setCode('');
      onAdded(c);
    } catch (e) {
      toast.error('Could not add', e.message);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title="Add a language" subtitle="Parents will be able to choose it once you publish its five clips" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button icon={Plus} onClick={add}>Add language</Button></>}>
      <div className="space-y-4">
        <div className="flex flex-wrap gap-2">
          {SUGGEST.map(([n, c]) => (
            <button key={c} type="button" onClick={() => (setName(n), setCode(c))} className="rounded-full border border-slate-200 px-3 py-1 text-sm font-semibold text-slate-700 hover:border-brand-400 dark:border-white/15 dark:text-slate-200">{n}</button>
          ))}
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Language name" className="col-span-2"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Ga" /></Field>
          <Field label="Short code" hint="2–3 letters"><Input value={code} onChange={(e) => setCode(e.target.value.toLowerCase())} placeholder="gaa" maxLength={3} /></Field>
        </div>
      </div>
    </Modal>
  );
}

export default function Studio() {
  const [packs, setPacks] = useState(null);
  const [lang, setLang] = useState(null);
  const [editing, setEditing] = useState(null);
  const [adding, setAdding] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [preview, setPreview] = useState(null);
  const audio = useRef(null);

  const load = useCallback(async () => {
    try {
      const rows = must(await supabase.from('voice_packs').select('*').order('sort'));
      setPacks(rows);
      setLang((l) => l || rows.find((r) => r.lang === 'tw')?.lang || rows[0]?.lang || null);
    } catch (e) {
      toast.error('Could not load the voices', e.message);
      setPacks([]);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const pack = useMemo(() => packs?.find((p) => p.lang === lang), [packs, lang]);
  const play = (key, path) => {
    audio.current?.pause();
    if (preview === key) return setPreview(null);
    const a = new Audio(voiceUrl(path));
    audio.current = a;
    a.onended = () => setPreview(null);
    a.play().catch(() => setPreview(null));
    setPreview(key);
  };
  useEffect(() => () => audio.current?.pause(), []);

  if (!supabase) return <Card><EmptyState icon={Mic} title="Record Studio needs the live app" text="Open the Admin app to record voices." /></Card>;
  if (editing && pack) return <Editor key={`${pack.lang}-${editing}`} pack={pack} clip={editing} onClose={() => setEditing(null)} onSaved={() => (load(), setEditing(null))} />;

  const ready = pack && CLIPS.every((c) => pack.draft?.[c]?.out);
  const changed = pack && CLIPS.some((c) => pack.draft?.[c]?.out && pack.draft[c].out !== pack.published?.[c]);

  const publish = async () => {
    if (!(await confirmDialog(`Publish ${pack.name}?`, `Parents who choose ${pack.name} get these five clips the next time they open the app. No app update needed.`, { danger: false, confirmLabel: 'Publish' }))) return;
    setPublishing(true);
    try {
      const rev = must(await supabase.rpc('publish_voice', { p_lang: pack.lang }));
      toast.success(`${pack.name} is live`, `Version ${rev} — phones pick it up on their next open.`);
      load();
    } catch (e) {
      toast.error('Could not publish', e.message);
    } finally {
      setPublishing(false);
    }
  };
  const toggleLive = async () => {
    try {
      must(await supabase.from('voice_packs').update({ live: !pack.live }).eq('lang', pack.lang));
      toast.success(pack.live ? `${pack.name} hidden from parents` : `${pack.name} offered to parents again`);
      load();
    } catch (e) {
      toast.error('Could not change', e.message);
    }
  };

  return (
    <>
      <PageHeader title="Record Studio" subtitle="Record the spoken bus alerts parents hear — in any language. Publish sends them to every phone, no app update." actions={<Button variant="secondary" icon={Plus} onClick={() => setAdding(true)}>Add language</Button>} />
      {!packs ? (
        <Card className="p-10 text-center text-sm text-slate-500"><Loader2 className="mx-auto mb-2 h-5 w-5 animate-spin" /> Loading voices…</Card>
      ) : (
        <div className="space-y-6">
          <div className="flex flex-wrap gap-2">
            {packs.map((p) => (
              <button key={p.lang} type="button" onClick={() => setLang(p.lang)} aria-pressed={lang === p.lang}
                className={cx('flex items-center gap-2 rounded-2xl border px-4 py-2.5 text-left transition', lang === p.lang ? 'border-brand-600 bg-brand-600 text-white shadow-sm' : 'border-slate-200 bg-white text-slate-700 hover:border-brand-400 dark:border-white/10 dark:bg-white/5 dark:text-slate-200')}>
                <Languages className="h-4 w-4" />
                <span className="font-semibold">{p.name}</span>
                <span className={cx('rounded-full px-2 py-0.5 text-[11px] font-bold', lang === p.lang ? 'bg-white/20' : p.rev ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300' : 'bg-slate-100 text-slate-500 dark:bg-white/10')}>
                  {p.rev ? `Live v${p.rev}` : 'Not live'}
                </span>
              </button>
            ))}
          </div>

          {pack && (
            <>
              <Card className="flex flex-wrap items-center gap-4 p-5">
                <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-brand-50 text-brand-600 dark:bg-brand-500/15 dark:text-brand-300"><Radio className="h-5 w-5" /></div>
                <div className="min-w-0 flex-1">
                  <p className="font-bold text-slate-900 dark:text-white">
                    {pack.rev ? `${pack.name} is live — version ${pack.rev}` : `${pack.name} is not live yet`}
                    {pack.rev > 0 && !pack.live && <span className="ml-2 text-sm font-semibold text-amber-600">(hidden from parents)</span>}
                  </p>
                  <p className="text-sm text-slate-500">
                    {ready ? (changed ? 'You have saved changes that parents do not have yet.' : 'Everything saved is live.') : `Record and save all five clips to publish (${CLIPS.filter((c) => pack.draft?.[c]?.out).length} of 5 done).`}
                  </p>
                </div>
                {pack.rev > 0 && <Button variant="ghost" icon={pack.live ? EyeOff : Eye} onClick={toggleLive}>{pack.live ? 'Hide from parents' : 'Offer to parents'}</Button>}
                <Button icon={publishing ? Loader2 : Send} disabled={!ready || !changed || publishing} onClick={publish}>{publishing ? 'Publishing…' : `Publish ${pack.name}`}</Button>
              </Card>

              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                {CLIPS.map((c) => {
                  const d = pack.draft?.[c];
                  const live = pack.published?.[c];
                  const state = !d?.out ? 'empty' : live === d.out ? 'live' : 'saved';
                  return (
                    <Card key={c} className="flex flex-col p-5">
                      <div className="flex items-start justify-between gap-3">
                        <p className="font-bold text-slate-900 dark:text-white">{CLIP_NAMES[c]}</p>
                        <Badge tone={state === 'live' ? 'green' : state === 'saved' ? 'amber' : 'slate'}>{state === 'live' ? 'Live' : state === 'saved' ? 'Saved, not live' : 'Not recorded'}</Badge>
                      </div>
                      <p className="mt-1 flex-1 text-sm text-slate-500">“{SCRIPTS[c]}”{pack.lang !== 'en' && <span className="block text-xs text-slate-400">Say it in {pack.name}</span>}</p>
                      {d?.out && <p className="mt-2 text-xs text-slate-400">{fmtSec(d.seconds)} · {d.lufs} LUFS · saved {new Date(d.updated_at).toLocaleDateString()}</p>}
                      <div className="mt-4 flex flex-wrap gap-2">
                        <Button size="sm" icon={d?.out ? SlidersHorizontal : Mic} onClick={() => setEditing(c)}>{d?.out ? 'Edit' : 'Record'}</Button>
                        {d?.out && <Button size="sm" variant="secondary" icon={preview === `d-${c}` ? Pause : Play} onClick={() => play(`d-${c}`, d.out)}>Saved</Button>}
                        {live && live !== d?.out && <Button size="sm" variant="ghost" icon={preview === `l-${c}` ? Pause : CheckCircle2} onClick={() => play(`l-${c}`, live)}>Live</Button>}
                      </div>
                    </Card>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}
      <AddLanguage open={adding} onClose={() => setAdding(false)} existing={(packs || []).map((p) => p.lang)} onAdded={(c) => (setAdding(false), load().then(() => setLang(c)))} />
    </>
  );
}
