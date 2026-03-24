import { useState, useEffect, useCallback, useRef } from 'react';

/**
 * Hook for managing audio input/output devices
 * Provides device enumeration, selection, and volume control
 */
export function useAudioDevices(settings) {
  const [inputDevices, setInputDevices] = useState([]);
  const [outputDevices, setOutputDevices] = useState([]);
  const [permissionGranted, setPermissionGranted] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const streamRef = useRef(null);
  const animationFrameRef = useRef(null);
  
  // Enumerate available devices
  const enumerateDevices = useCallback(async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      
      const inputs = devices
        .filter(d => d.kind === 'audioinput')
        .map(d => ({
          value: d.deviceId || 'default',
          label: d.label || `Microphone ${(d.deviceId || 'unknown').slice(0, 8)}`,
        }));
      
      const outputs = devices
        .filter(d => d.kind === 'audiooutput')
        .map(d => ({
          value: d.deviceId || 'default',
          label: d.label || `Speaker ${(d.deviceId || 'unknown').slice(0, 8)}`,
        }));
      
      // Add default option if not present
      if (!inputs.some(d => d.value === 'default')) {
        inputs.unshift({ value: 'default', label: 'Par défaut' });
      }
      if (!outputs.some(d => d.value === 'default')) {
        outputs.unshift({ value: 'default', label: 'Par défaut' });
      }
      
      setInputDevices(inputs);
      setOutputDevices(outputs);
      setPermissionGranted(devices.some(d => d.label));
    } catch (err) {
      console.error('Error enumerating devices:', err);
    }
  }, []);
  
  // Request microphone permission
  const requestPermission = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(track => track.stop());
      setPermissionGranted(true);
      await enumerateDevices();
    } catch (err) {
      console.error('Microphone permission denied:', err);
      setPermissionGranted(false);
    }
  }, [enumerateDevices]);
  
  // Start microphone test with visualization
  const startMicTest = useCallback(async () => {
    try {
      const baseAudio = {
        echoCancellation: settings?.echo_cancellation ?? true,
        noiseSuppression: settings?.noise_suppression ?? true,
        autoGainControl: settings?.auto_gain_control ?? true,
      };

      const hasDevice = settings?.input_device && settings.input_device !== 'default';
      const preferredConstraints = {
        audio: hasDevice
          ? { ...baseAudio, deviceId: { exact: settings.input_device } }
          : baseAudio,
      };

      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia(preferredConstraints);
      } catch (deviceErr) {
        if (hasDevice) {
          console.warn('Mic test: preferred device failed, retrying default:', deviceErr.message);
          stream = await navigator.mediaDevices.getUserMedia({ audio: baseAudio });
        } else {
          throw deviceErr;
        }
      }
      streamRef.current = stream;
      
      audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)();
      if (audioContextRef.current.state === 'suspended') {
        await audioContextRef.current.resume();
      }
      analyserRef.current = audioContextRef.current.createAnalyser();
      analyserRef.current.fftSize = 256;
      
      const source = audioContextRef.current.createMediaStreamSource(stream);
      
      // Apply input volume via gain node
      const gainNode = audioContextRef.current.createGain();
      gainNode.gain.value = (settings?.input_volume ?? 100) / 100;
      
      source.connect(gainNode);
      gainNode.connect(analyserRef.current);
      
      // Start level monitoring
      const dataArray = new Uint8Array(analyserRef.current.frequencyBinCount);
      
      const updateLevel = () => {
        if (!analyserRef.current) return;
        
        analyserRef.current.getByteFrequencyData(dataArray);
        const average = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
        const normalizedLevel = Math.min(100, (average / 128) * 100);
        
        // Apply sensitivity threshold
        const sensitivity = settings?.input_sensitivity ?? 50;
        const threshold = 100 - sensitivity;
        const adjustedLevel = normalizedLevel > threshold ? normalizedLevel : 0;
        
        setMicLevel(adjustedLevel);
        animationFrameRef.current = requestAnimationFrame(updateLevel);
      };
      
      updateLevel();
      return true;
    } catch (err) {
      console.error('Error starting mic test:', err);
      return false;
    }
  }, [settings]);
  
  // Stop microphone test
  const stopMicTest = useCallback(() => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
    }
    
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    
    analyserRef.current = null;
    setMicLevel(0);
  }, []);
  
  // Set output device on an audio element
  const setOutputDevice = useCallback(async (audioElement, deviceId) => {
    if (!audioElement || !audioElement.setSinkId) {
      console.warn('setSinkId not supported');
      return false;
    }
    
    try {
      await audioElement.setSinkId(deviceId || 'default');
      return true;
    } catch (err) {
      console.error('Error setting output device:', err);
      return false;
    }
  }, []);
  
  // Play test sound
  const playTestSound = useCallback(async () => {
    try {
      const audio = new Audio('/sounds/notification.mp3');
      audio.volume = (settings?.output_volume ?? 100) / 100;
      
      if (settings?.output_device && settings.output_device !== 'default' && audio.setSinkId) {
        await audio.setSinkId(settings.output_device);
      }
      
      await audio.play();
    } catch (err) {
      console.error('Error playing test sound:', err);
    }
  }, [settings]);
  
  // Initial device enumeration — auto-request permission if devices lack labels
  useEffect(() => {
    (async () => {
      await enumerateDevices();
      // If after enumeration we have no labels, prompt for permission once
      if (!permissionGranted) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          stream.getTracks().forEach(t => t.stop());
          setPermissionGranted(true);
          await enumerateDevices();
        } catch (_) {
          // User denied — continue with unlabeled devices
        }
      }
    })();

    // Listen for device changes
    const handleDeviceChange = () => enumerateDevices();
    navigator.mediaDevices?.addEventListener('devicechange', handleDeviceChange);

    return () => {
      navigator.mediaDevices?.removeEventListener('devicechange', handleDeviceChange);
      stopMicTest();
    };
  }, [enumerateDevices, stopMicTest]);
  
  return {
    inputDevices,
    outputDevices,
    permissionGranted,
    micLevel,
    requestPermission,
    startMicTest,
    stopMicTest,
    setOutputDevice,
    playTestSound,
  };
}

export default useAudioDevices;
