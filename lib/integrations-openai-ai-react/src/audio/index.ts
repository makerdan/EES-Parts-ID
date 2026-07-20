/**
 * Voice chat client utilities for Replit AI Integrations.
 * 
 * Usage:
 * 1. Copy audio-playback-worklet.js to your public/ folder
 * 2. Pass the deployed worklet URL into the hooks
 * 
 * Example:
 * ```tsx
 * import { useVoiceRecorder, useVoiceStream } from "./audio";
 * 
 * function VoiceChat({ workletPath }: { workletPath: string }) {
 *   const [transcript, setTranscript] = useState("");
 *   const recorder = useVoiceRecorder();
 *   const stream = useVoiceStream({
 *     workletPath,
 *     onTranscript: (_, full) => setTranscript(full),
 *     onComplete: (text) => console.log("Done:", text),
 *   });
 * 
 *   const handleClick = async () => {
 *     if (recorder.state === "recording") {
 *       const blob = await recorder.stopRecording();
 *       await stream.streamVoiceResponse("/api/openai/conversations/1/voice-messages", blob);
 *     } else {
 *       await recorder.startRecording();
 *     }
 *   };
 * 
 *   return (
 *     <div>
 *       <button onClick={handleClick}>
 *         {recorder.state === "recording" ? "Stop" : "Record"}
 *       </button>
 *       <p>{transcript}</p>
 *     </div>
 *   );
 * }
 * ```
 */

export { createAudioPlaybackContext,decodePCM16ToFloat32 } from "./audio-utils";
export { type PlaybackState,useAudioPlayback } from "./useAudioPlayback";
export { type RecordingState,useVoiceRecorder } from "./useVoiceRecorder";
export { useVoiceStream } from "./useVoiceStream";
