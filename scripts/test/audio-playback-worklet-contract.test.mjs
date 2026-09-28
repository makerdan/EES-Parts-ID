#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";

const workletPath = resolve(
  "lib/integrations-openai-ai-react/src/audio/audio-playback-worklet.js",
);
const source = readFileSync(workletPath, "utf8");
const postedMessages = [];
let Processor;

class AudioWorkletProcessorFixture {
  constructor() {
    this.port = {
      onmessage: null,
      postMessage: (message) => postedMessages.push(message),
    };
  }
}

runInNewContext(source, {
  AudioWorkletProcessor: AudioWorkletProcessorFixture,
  registerProcessor: (name, processor) => {
    assert.equal(name, "audio-playback-processor");
    Processor = processor;
  },
});

assert.equal(typeof Processor, "function", "worklet processor must register");
const processor = new Processor();

function send(type, samples) {
  processor.port.onmessage({ data: { type, samples } });
}

function renderPair(initialValue = 9) {
  const left = new Float32Array(2).fill(initialValue);
  const right = new Float32Array(2).fill(initialValue);
  processor.process([], [[left, right]]);
  return [left, right];
}

send("audio", new Float32Array([0.125, 0.25, 0.375, 0.5]));
send("streamComplete");
const [firstLeft, firstRight] = renderPair();
assert.deepEqual([...firstLeft], [0.125, 0.25]);
assert.deepEqual([...firstRight], [...firstLeft]);

send("stop");
const [stoppedLeft, stoppedRight] = renderPair();
assert.deepEqual([...stoppedLeft], [0, 0], "idle output must overwrite stale left samples");
assert.deepEqual([...stoppedRight], [0, 0], "idle output must overwrite stale right samples");

send("audio", new Float32Array([0.625, 0.75]));
const [nextLeft, nextRight] = renderPair();
assert.deepEqual([...nextLeft], [0.625, 0.75], "new playback must start at its first sample");
assert.deepEqual([...nextRight], [...nextLeft]);
assert.deepEqual(
  postedMessages,
  [],
  "stop must reset stream-completion state before the next stream",
);

send("stop");
const [idleLeft, idleRight] = renderPair();
assert.deepEqual([...idleLeft], [0, 0]);
assert.deepEqual([...idleRight], [0, 0]);

console.log("Audio playback worklet contract: stop discards queued samples and all channels are initialized");