// Optional same-producer output spool. An FFmpeg process continues feeding its
// EXISTING remux recorder while HTTP backpressure holds the MSE reader. This
// never creates another FFmpeg, torrent reader, recorder, token or disk pool.
// The server must verify every source piece is local before opting in.
import { Duplex } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const MiB = 1024 * 1024;
const DEFAULT_MAX_BYTES = 64 * MiB;
const MAX_BYTES = 96 * MiB;
const DEFAULT_MAX_CHUNK = 256 * 1024;
const TOKEN = /^[0-9a-f]{48}$/;

export class BoundedRemuxOutputSpool extends Duplex {
  constructor({maxBufferedBytes=DEFAULT_MAX_BYTES, maxChunkBytes=DEFAULT_MAX_CHUNK,
    sourceGeneration, getCurrentGeneration, isVerifiedComplete, signal,
    onAbort=()=>{}}={}) {
    if(!Number.isSafeInteger(maxBufferedBytes)||maxBufferedBytes<64*1024||maxBufferedBytes>MAX_BYTES
      ||!Number.isSafeInteger(maxChunkBytes)||maxChunkBytes<1024
      ||maxChunkBytes>256*1024||maxChunkBytes>maxBufferedBytes/2
      ||!TOKEN.test(String(sourceGeneration))||typeof getCurrentGeneration!=='function'
      ||typeof isVerifiedComplete!=='function'||typeof onAbort!=='function')
      throw Error('Unverified or unbounded remux run-ahead setup');
    super({readableHighWaterMark:Math.min(64*1024,maxBufferedBytes/4),
      // Do not let Node accumulate another hidden writable HWM-sized queue
      // outside our explicitly counted readable/custom/pending allocation.
      writableHighWaterMark:1,allowHalfOpen:false,autoDestroy:true});
    this.limit=maxBufferedBytes;
    this.maxChunkBytes=maxChunkBytes;
    this.sourceGeneration=sourceGeneration;
    this.getCurrentGeneration=getCurrentGeneration;
    this.isVerifiedComplete=isVerifiedComplete;
    this.onAbort=onAbort;
    this.queue=[];
    this.queuedBytes=0;
    this.pending=null;
    this.inputEnded=false;
    this.outputEnded=false;
    this.totalAcceptedBytes=0;
    this.peakBufferedBytes=0;
    this.abortReported=false;
    this.signal=signal;
    this.abortHandler=()=>this.destroy(Error('Remux run-ahead aborted'));
    if(signal) {
      if(signal.aborted)queueMicrotask(this.abortHandler);
      else signal.addEventListener('abort',this.abortHandler,{once:true});
    }
  }
  get bufferedBytes(){
    return this.readableLength+this.queuedBytes+(this.pending?.chunk?.length||0);
  }
  _validSource() {
    try{return this.getCurrentGeneration()===this.sourceGeneration&&this.isVerifiedComplete()===true;}
    catch{return false;}
  }
  _write(chunk,_encoding,callback) {
    if(!this._validSource()) {callback(Error('Run-ahead source generation or local completion revoked'));return;}
    if(chunk.length>this.maxChunkBytes) {callback(Error('Oversized run-ahead write chunk'));return;}
    if(!chunk.length) {callback();return;}
    // Reserve one full future chunk inside the hard limit. If full, hold this
    // _write callback, which propagates backpressure into FFmpeg and recorder.
    this.pending={chunk,callback};
    this._flush();
  }
  _read() {this._flush();}
  read(size) {
    const value=super.read(size);
    // _read() is invoked *before* Node consumes its internal readable queue.
    // A full-window pending write could be rejected there and otherwise never
    // reconsidered once the last buffered read depleted the queue.
    if(this.pending&&!this.destroyed)queueMicrotask(()=>this._flush());
    return value;
  }
  _flush() {
    if(this.destroyed)return;
    if(!this._validSource()) {
      this.destroy(Error('Run-ahead source generation or local completion revoked'));
      return;
    }
    // Keep a maxChunkBytes guard even after accepting the current chunk:
    // Node may synchronously hand us the NEXT write before a stalled response
    // drains anything. The current queue plus that next pending write must
    // still fit within maxBufferedBytes.
    if(this.pending && this.readableLength+this.queuedBytes+this.pending.chunk.length
      <=this.limit-this.maxChunkBytes) {
      const {chunk,callback}=this.pending;
      this.pending=null;
      this.queue.push(chunk);
      this.queuedBytes+=chunk.length;
      this.totalAcceptedBytes+=chunk.length;
      this.peakBufferedBytes=Math.max(this.peakBufferedBytes,this.bufferedBytes);
      callback();
    }
    while(this.queue.length) {
      const chunk=this.queue.shift();
      this.queuedBytes-=chunk.length;
      if(!this.push(chunk))break;
    }
    this.peakBufferedBytes=Math.max(this.peakBufferedBytes,this.bufferedBytes);
    if(this.inputEnded&&!this.queue.length&&!this.pending&&!this.outputEnded) {
      this.outputEnded=true;
      this.push(null);
    }
  }
  _final(callback) {
    this.inputEnded=true;
    this._flush();
    callback();
  }
  _destroy(error,callback) {
    this.signal?.removeEventListener('abort',this.abortHandler);
    if(this.pending) {
      const pending=this.pending;
      this.pending=null;
      pending.callback(error||Error('Run-ahead spool destroyed'));
    }
    this.queue=[];
    this.queuedBytes=0;
    if(error&&!this.abortReported) {
      this.abortReported=true;
      try{this.onAbort(error);}catch{}
    }
    callback(error);
  }
}

// Caller must provide remuxRecorder.transform as source, NOT ffmpeg.stdout.
// This ordering keeps one recorder and the exact active MSE producer token.
// The returned promise settles after both HTTP and recorder stream teardown.
export function pipeRemuxAhead({source,response,signal,sourceGeneration,
  getCurrentGeneration,isVerifiedComplete,maxBufferedBytes=DEFAULT_MAX_BYTES,
  maxChunkBytes=DEFAULT_MAX_CHUNK,onAbort=()=>{}}={}) {
  let verified=false;
  try{verified=isVerifiedComplete?.()===true&&getCurrentGeneration?.()===sourceGeneration;}
  catch{verified=false;}
  if(!source?.pipe||!response?.write||typeof source.on!=='function'
    ||typeof response.on!=='function'||!verified)
    return {started:false,reason:'run-ahead requires verified source and active response'};
  const spool=new BoundedRemuxOutputSpool({maxBufferedBytes,maxChunkBytes,
    sourceGeneration,getCurrentGeneration,isVerifiedComplete,signal,onAbort});
  const done=pipeline(source,spool,response)
    .then(()=>({completed:true,bytes:spool.totalAcceptedBytes,peakBufferedBytes:spool.peakBufferedBytes}))
    .catch(error=>({completed:false,error,bytes:spool.totalAcceptedBytes,
      peakBufferedBytes:spool.peakBufferedBytes}));
  return {
    started:true,done,spool,
    cancel(reason=Error('Run-ahead cancellation')) {
      spool.destroy(reason instanceof Error?reason:Error(String(reason)));
    },
    get bufferedBytes(){return spool.bufferedBytes;},
    get peakBufferedBytes(){return spool.peakBufferedBytes;},
  };
}
