import React from 'react';
import * as Redux from 'redux';
import thunk from 'redux-thunk';
import { act, fireEvent, render, screen } from '@testing-library/react';

import DriveVideo from '.';
import * as Types from '../../actions/types';
import rootReducer from '../../reducers';
import { createInitialState } from '../../initialState';
import { pause, seek, selectLoop, setPlaybackSpeed, videoProgress } from '../../timeline/playback';

vi.mock('../../api/backend', () => ({
  api: { video: { getQcameraStreamUrl: () => 'https://video.example.com/qcamera.m3u8' } },
}));

const hlsPlayers = vi.hoisted(() => []);
vi.mock('hls.js/light', () => ({
  default: class {
    static Events = { ERROR: 'hlsError' };
    handlers = {};
    startLoad = vi.fn();
    constructor() { hlsPlayers.push(this); }
    on(event, handler) { this.handlers[event] = handler; }
    loadSource() {}
    attachMedia() {}
    stopLoad() {}
    destroy() {}
  },
}));

const currentRoute = { fullname: 'aaaaaaaaaaaaaaaa|2026-08-06--12-00-00', videoStartOffset: 2000 };
const loop = { startTime: 5000, duration: 2000 };

function renderVideo(state = {}, props = {}) {
  const store = Redux.createStore(
    rootReducer,
    { ...createInitialState('/'), currentRoute, ...state },
    Redux.applyMiddleware(thunk),
  );
  const { container } = render(<DriveVideo store={store} {...props} />);
  const video = container.querySelector('video');
  Object.defineProperty(video, 'readyState', { value: video.HAVE_ENOUGH_DATA, configurable: true });
  return { store, video };
}

describe('drive video', () => {
  beforeAll(() => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockReturnValue();
  });
  afterAll(() => vi.restoreAllMocks());
  afterEach(() => {
    delete window.MediaSource;
    vi.useRealTimers();
  });

  it('follows pause and play both ways', () => {
    const { store, video } = renderVideo();
    const videoPause = vi.spyOn(video, 'pause');
    Object.defineProperty(video, 'paused', { value: false, configurable: true });
    act(() => store.dispatch(pause()));
    expect(videoPause).toHaveBeenCalled();

    fireEvent.play(video);
    expect(store.getState().isPlaying).toEqual(true);
    Object.defineProperty(video, 'paused', { value: true });
    fireEvent.pause(video);
    expect(store.getState().isPlaying).toEqual(false);
    expect(videoPause).toHaveBeenCalledTimes(1);
  });

  it('sets the speed while paused and follows the browser', () => {
    const { store, video } = renderVideo({ isPlaying: false });
    act(() => store.dispatch(setPlaybackSpeed(2)));
    expect(video.playbackRate).toEqual(2);
    expect(video.defaultPlaybackRate).toEqual(2);

    act(() => { video.playbackRate = 1.5; });
    expect(store.getState().desiredPlaySpeed).toEqual(1.5);
  });

  it('follows a mute from the browser', () => {
    const onMuteChange = vi.fn();
    const { video } = renderVideo({}, { isMuted: true, onMuteChange });
    fireEvent.volumeChange(video);
    expect(onMuteChange).not.toHaveBeenCalled();
    video.muted = false;
    expect(onMuteChange).toHaveBeenCalledWith(false);
  });

  it('does not re-render on progress', () => {
    const onRender = vi.fn();
    const store = Redux.createStore(rootReducer, { ...createInitialState('/'), currentRoute }, Redux.applyMiddleware(thunk));
    render(<React.Profiler id="video" onRender={onRender}><DriveVideo store={store} /></React.Profiler>);
    onRender.mockClear();
    act(() => store.dispatch(videoProgress(5000)));
    expect(onRender).not.toHaveBeenCalled();
  });

  it('seeks even if progress is reported before the render', () => {
    const { store, video } = renderVideo();
    act(() => {
      store.dispatch(seek(80000));
      store.dispatch(videoProgress(3000));
    });
    expect(video.currentTime).toEqual(78);
  });

  it('follows a seek from the browser at once', () => {
    const { store, video } = renderVideo();
    Object.defineProperty(video, 'seeking', { value: true });
    video.currentTime = 30;
    fireEvent.seeking(video);
    expect(store.getState().offset).toEqual(32000);
  });

  it('retries after an error on a seek or when back online', () => {
    const { store, video } = renderVideo();
    Object.defineProperty(video, 'error', { value: { code: 2 } });
    fireEvent.error(video);
    expect(screen.getByText('Unable to load video')).toBeInTheDocument();

    act(() => store.dispatch(seek(12000)));
    expect(screen.queryByText('Unable to load video')).toBeNull();
    expect(video.currentTime).toEqual(0);
    fireEvent.loadedMetadata(video);
    expect(video.currentTime).toEqual(10);

    fireEvent.error(video);
    fireEvent(window, new Event('online'));
    expect(screen.queryByText('Unable to load video')).toBeNull();
  });

  it('loops the selection', () => {
    const { store, video } = renderVideo({ loop });
    video.currentTime = 5.5;
    fireEvent.timeUpdate(video);
    expect(video.currentTime).toEqual(3);

    // at the end the browser pauses the video, then fires ended
    video.currentTime = 6;
    Object.defineProperty(video, 'duration', { value: 6, configurable: true });
    Object.defineProperty(video, 'paused', { value: true });
    Object.defineProperty(video, 'ended', { value: true });
    fireEvent.pause(video);
    fireEvent.ended(video);
    expect(video.currentTime).toEqual(3);
    expect(store.getState().isPlaying).toEqual(true);

    // the selection starts after the end of the uploaded video
    Object.defineProperty(video, 'duration', { value: 2 });
    fireEvent.ended(video);
    expect(store.getState().isPlaying).toEqual(false);
  });

  it('pauses on a selection with no video', () => {
    const { store, video } = renderVideo({ loop: { startTime: 0, duration: 1000 } });
    const message = 'This video segment has not uploaded yet or has been deleted.';
    fireEvent.timeUpdate(video);
    expect(screen.getByText(message)).toBeInTheDocument();
    expect(store.getState().isPlaying).toEqual(false);

    act(() => store.dispatch(selectLoop(500, 1500)));
    expect(screen.getByText(message)).toBeInTheDocument();
    expect(store.getState().isPlaying).toEqual(false);

    act(() => store.dispatch(selectLoop(3000, 5000)));
    expect(screen.queryByText(message)).toBeNull();
    expect(video.currentTime).toEqual(1);
    expect(store.getState().isPlaying).toEqual(true);
  });

  it('reseeks when route events move the first frame', () => {
    const { store, video } = renderVideo();
    video.currentTime = 5;
    fireEvent.timeUpdate(video);
    act(() => store.dispatch({
      type: Types.ACTION_UPDATE_ROUTE_EVENTS,
      fullname: currentRoute.fullname,
      events: [{ type: 'event', route_offset_millis: 3000, data: { event_type: 'first_road_camera_frame' } }],
    }));
    expect(video.currentTime).toEqual(4);
  });

  it('tracks and loops every frame, shows Retry on a stall', () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] });
    const { store, video } = renderVideo({ loop });
    Object.defineProperty(video, 'paused', { value: false });
    fireEvent.play(video);
    fireEvent.canPlay(video);
    video.currentTime = 4;
    act(() => vi.advanceTimersToNextFrame());
    expect(store.getState().offset).toEqual(6000);
    video.currentTime = 5.5;
    act(() => vi.advanceTimersToNextFrame());
    expect(video.currentTime).toEqual(3);
    expect(screen.queryByRole('progressbar')).toBeNull();

    act(() => vi.advanceTimersByTime(1100));
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
    expect(screen.queryByText('Retry')).toBeNull();
    act(() => vi.advanceTimersByTime(30000));
    fireEvent.click(screen.getByText('Retry'));
    expect(screen.queryByText('Retry')).toBeNull();
  });

  it('skips a missing segment', async () => {
    window.MediaSource = class {};
    const { video } = renderVideo();
    await act(async () => {});
    Object.defineProperty(video, 'readyState', { value: video.HAVE_METADATA });
    act(() => hlsPlayers.at(-1).handlers.hlsError('hlsError', { details: 'fragLoadError', response: { code: 404 }, frag: { start: 0, end: 60 } }));
    expect(video.currentTime).toEqual(60.3);
    expect(hlsPlayers.at(-1).startLoad).toHaveBeenCalledWith(60.3);
  });
});
