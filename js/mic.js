/* Shared microphone input. One stream, reference counted, fed into the app's
   AudioContext. Only live while the tuner or the level meter is running; the
   audio never leaves the device. */

import { audioCtx, resume } from './audio.js';

let stream = null, source = null, users = 0;

export async function acquire(fftSize){
  const ctx = audioCtx();
  await resume();
  if(!stream){
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    });
    source = ctx.createMediaStreamSource(stream);
  }
  const analyser = ctx.createAnalyser();
  analyser.fftSize = fftSize || 2048;
  analyser.smoothingTimeConstant = 0.2;
  source.connect(analyser);     // analyser is not connected on to the output
  users++;
  return analyser;
}

export function release(analyser){
  if(analyser){
    try{ analyser.disconnect(); }catch(err){}
  }
  users = Math.max(0, users - 1);
  if(users === 0 && stream){
    try{ source.disconnect(); }catch(err){}
    stream.getTracks().forEach(t => { try{ t.stop(); }catch(err){} });
    stream = null; source = null;
  }
}

export function micError(err){
  const n = err && err.name;
  if(n === 'NotAllowedError' || n === 'SecurityError') return 'Microphone blocked. Allow it in the site settings and try again.';
  if(n === 'NotFoundError') return 'No microphone found.';
  if(n === 'NotReadableError') return 'Something else is using the microphone.';
  return 'Could not start the microphone.';
}
