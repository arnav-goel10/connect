import { analyticsMiddleware } from './analytics';
import { pause, play, setPlaybackSpeed } from './timeline/playback';

const zoom = { start: 0, end: 1000 };

function videoEvents(state, action) {
  const gtag = vi.fn();
  vi.stubGlobal('gtag', gtag);
  analyticsMiddleware({ getState: () => state })(() => {})(action);
  vi.unstubAllGlobals();
  return gtag.mock.calls.map(([, name, params]) => [name, params.play_speed, params.play_percentage]);
}

describe('analytics', () => {
  it('logs only the plays and pauses the user asked for', () => {
    const paused = { zoom, offset: 250, isPlaying: false, desiredPlaySpeed: 2 };
    const playing = { ...paused, isPlaying: true };
    expect(videoEvents(paused, pause(true))).toEqual([]);
    expect(videoEvents(paused, pause())).toEqual([['video_pause', 0, 0.25]]);
    expect(videoEvents(playing, play(true))).toEqual([]);
    expect(videoEvents(playing, play())).toEqual([['video_play', 2, 0.25]]);
    expect(videoEvents(paused, setPlaybackSpeed(2))).toEqual([]);
    expect(videoEvents(playing, setPlaybackSpeed(2))).toEqual([['video_play', 2, 0.25]]);
    expect(videoEvents(playing, setPlaybackSpeed(2, true))).toEqual([]);
  });
});
