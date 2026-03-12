import React, { createContext, useContext, useCallback, useRef, useMemo, useEffect } from 'react';
import SettingsContext from './SettingsContext';

const SoundContext = createContext(null);

// Web Audio API helpers - generate sounds without external files
function getAudioContext() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  return new Ctx();
}

function playTone(ctx, destination, frequency, duration, volume = 0.3, type = 'sine') {
  if (!ctx || !destination) return;
  try {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(destination);
    osc.frequency.value = frequency;
    osc.type = type;
    gain.gain.setValueAtTime(volume, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + duration);
  } catch (_) {}
}

function playChime(ctx, destination, volume = 0.25) {
  if (!ctx) return;
  playTone(ctx, destination, 880, 0.08, volume, 'sine');
  setTimeout(() => playTone(ctx, destination, 1109, 0.12, volume * 0.9, 'sine'), 80);
}

function playPingSound(ctx, destination, volume = 0.3) {
  if (!ctx) return;
  playTone(ctx, destination, 1319, 0.06, volume, 'sine');
  setTimeout(() => playTone(ctx, destination, 1661, 0.08, volume * 0.8, 'sine'), 60);
}

function playMessageSentSound(ctx, destination, volume = 0.15) {
  if (!ctx) return;
  playTone(ctx, destination, 600, 0.04, volume, 'sine');
}

function playCallEndSound(ctx, destination, volume = 0.2) {
  if (!ctx) return;
  playTone(ctx, destination, 400, 0.1, volume, 'sine');
  setTimeout(() => playTone(ctx, destination, 350, 0.15, volume * 0.8, 'sine'), 100);
}

function playSoftTone(ctx, destination, frequency, duration, volume, attack = 0.03) {
  if (!ctx || !destination) return;
  try {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(destination);
    osc.frequency.value = frequency;
    osc.type = 'sine';
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(volume, ctx.currentTime + attack);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + duration);
  } catch (_) {}
}

function createRingtone(ctx, destination, volume = 0.35) {
  const ringVolume = Math.min(volume * 0.25, 0.06);
  const ring = () => {
    playSoftTone(ctx, destination, 220, 0.25, ringVolume, 0.04);
    setTimeout(() => playSoftTone(ctx, destination, 277, 0.3, ringVolume, 0.04), 180);
  };
  ring();
  return setInterval(ring, 2400);
}

export function SoundProvider({ children }) {
  // useContext instead of useSettings to avoid crash during HMR when SettingsContext
  // may briefly be unavailable; fallback to empty object when outside provider
  const settingsContext = useContext(SettingsContext);
  const settings = settingsContext?.settings ?? {};
  const ctxRef = useRef(null);
  const ringIntervalRef = useRef(null);
  const streamDestRef = useRef(null);
  const routedAudioRef = useRef(null);

  const getCtx = useCallback(() => {
    if (!ctxRef.current) {
      ctxRef.current = getAudioContext();
    }
    const ctx = ctxRef.current;
    if (ctx?.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
    return ctx;
  }, []);

  const outputDevice = settings?.output_device;
  const useDeviceRouting = outputDevice && outputDevice !== 'default';

  const getDestination = useCallback(() => {
    const ctx = getCtx();
    if (!ctx) return { ctx: null, dest: null };

    if (!useDeviceRouting) {
      return { ctx, dest: ctx.destination };
    }

    if (!streamDestRef.current) {
      streamDestRef.current = ctx.createMediaStreamDestination();
      const audio = new Audio();
      audio.autoplay = true;
      audio.playsInline = true;
      audio.volume = (settings?.output_volume ?? 100) / 100;
      audio.srcObject = streamDestRef.current.stream;
      if (audio.setSinkId) {
        audio.setSinkId(outputDevice).catch(() => {});
      }
      audio.play().catch(() => {});
      routedAudioRef.current = audio;
    } else if (routedAudioRef.current?.setSinkId && routedAudioRef.current.volume !== undefined) {
      routedAudioRef.current.volume = (settings?.output_volume ?? 100) / 100;
      routedAudioRef.current.setSinkId(outputDevice).catch(() => {});
    }
    return { ctx, dest: streamDestRef.current };
  }, [getCtx, useDeviceRouting, outputDevice, settings?.output_volume]);

  useEffect(() => {
    if (!useDeviceRouting && streamDestRef.current) {
      if (routedAudioRef.current) {
        routedAudioRef.current.srcObject = null;
        routedAudioRef.current.pause();
        routedAudioRef.current = null;
      }
      streamDestRef.current = null;
    } else if (useDeviceRouting && routedAudioRef.current?.setSinkId) {
      routedAudioRef.current.setSinkId(outputDevice).catch(() => {});
      routedAudioRef.current.volume = (settings?.output_volume ?? 100) / 100;
    }
  }, [useDeviceRouting, outputDevice, settings?.output_volume]);

  const volume = useMemo(() => (settings?.output_volume ?? 100) / 100, [settings?.output_volume]);
  const soundVolume = volume * 0.4;

  const playNotification = useCallback(({ force = false } = {}) => {
    if (!force && settings?.notification_sound === false) return;
    const { ctx, dest } = getDestination();
    if (ctx && dest) playChime(ctx, dest, soundVolume);
  }, [settings?.notification_sound, getDestination, soundVolume]);

  const playPing = useCallback(() => {
    if (settings?.notification_sound === false) return;
    const { ctx, dest } = getDestination();
    if (ctx && dest) playPingSound(ctx, dest, soundVolume);
  }, [settings?.notification_sound, getDestination, soundVolume]);

  const playMessageSent = useCallback(() => {
    if (settings?.notification_sound === false) return;
    const { ctx, dest } = getDestination();
    if (ctx && dest) playMessageSentSound(ctx, dest, soundVolume * 0.5);
  }, [settings?.notification_sound, getDestination, soundVolume]);

  const playCallEnd = useCallback(() => {
    const { ctx, dest } = getDestination();
    if (ctx && dest) playCallEndSound(ctx, dest, soundVolume);
  }, [getDestination, soundVolume]);

  const startRingtone = useCallback(({ force = false } = {}) => {
    if (!force && settings?.notification_sound === false) return;
    const { ctx, dest } = getDestination();
    if (!ctx || !dest) return;
    if (ringIntervalRef.current) return;
    ringIntervalRef.current = createRingtone(ctx, dest, soundVolume);
  }, [settings?.notification_sound, getDestination, soundVolume]);

  const stopRingtone = useCallback(() => {
    if (ringIntervalRef.current) {
      clearInterval(ringIntervalRef.current);
      ringIntervalRef.current = null;
    }
  }, []);

  const value = useMemo(() => ({
    playNotification,
    playPing,
    playMessageSent,
    playCallEnd,
    startRingtone,
    stopRingtone,
  }), [playNotification, playPing, playMessageSent, playCallEnd, startRingtone, stopRingtone]);

  return (
    <SoundContext.Provider value={value}>
      {children}
    </SoundContext.Provider>
  );
}

export function useSounds() {
  const ctx = useContext(SoundContext);
  if (!ctx) return {
    playNotification: () => {},
    playPing: () => {},
    playMessageSent: () => {},
    playCallEnd: () => {},
    startRingtone: () => {},
    stopRingtone: () => {},
  };
  return ctx;
}
