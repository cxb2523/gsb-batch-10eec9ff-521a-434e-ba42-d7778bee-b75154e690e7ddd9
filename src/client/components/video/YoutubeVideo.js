import { Component } from 'react';
import { get } from '@client/container';
import Loop from '@client/common/Loop';
import Video from '@client/components/video/Video';
import createTimeRanges from '@client/components/video/TimeRanges';
// import Subtitles from '@client/components/Subtitles';

export default class YoutubeVideo extends Component {
    static propTypes = Video.propTypes;
    static defaultProps = Video.defaultProps;

    constructor(props) {
        super(props);

        this.api = get('api');
        this.loop = new Loop(this.onUpdate, 500);
        this.element = null;
        this.player = null;
        this.ready = false;
        this.authorizedOnce = false;
        this.authorizationTimeout = null;
        this.options = {
            controls: 0,
            showInfo: 0,
            // fs: 0,
            // disablekb: 1,
            enablejsapi: 1,
            // playsinline: 0,
            modestbranding: 1,
            autoplay: 0,
            origin: location.origin
        };

        this.setElement = this.setElement.bind(this);
        this.checkAuthorization = this.checkAuthorization.bind(this);
        this.onUpdate = this.onUpdate.bind(this);
        this.onResize = this.onResize.bind(this);
        this.onReady = this.onReady.bind(this);
        this.onStateChange = this.onStateChange.bind(this);
        this.onError = this.onError.bind(this);
        this.play = this.play.bind(this);
        this.seek = this.seek.bind(this);
    }

    get currentTime() {
        return this.ready ? parseFloat(this.player.getCurrentTime().toFixed(3), 10) : 0;
    }

    get duration() {
        return this.ready ? parseFloat(this.player.getDuration().toFixed(3), 10) : 0;
    }

    get buffered() {
        if (!this.ready) {
            return createTimeRanges();
        }

        const loaded = this.player.getVideoLoadedFraction() * this.duration;

        return createTimeRanges(loaded > 0 ? [[0, loaded]] : []);
    }

    componentDidMount() {
        this.props.setLoaded(false);
        window.addEventListener('resize', this.onResize);
        this.player = new YT.Player(
            this.element.id,
            {
                playerVars: this.options,
                events: {
                    onReady: this.onReady,
                    onStateChange: this.onStateChange,
                    onError: this.onError,
                }
            }
        );
    }

    componentWillUnmount() {
        window.removeEventListener('resize', this.onResize);
        this.cancelAuthorizationCheck();
        this.loop.stop();
        this.ready = false;
        this.player.destroy();
        this.player = null;
    }

    componentDidUpdate(prevProps) {
        const { time, playing, volume } = this.props;

        if (playing !== prevProps.playing) {
            playing ? this.play(time) : this.pause(time);
        } else if (time !== prevProps.time) {
            this.seek(time);
        }

        if (volume !== prevProps.volume) {
            this.setVolume(volume);
        }
    }

    setElement(element) {
        this.element = element;
    }

    play(time) {
        if (this.player.getPlayerState() !== 1) {
            this.seek(time);
            this.player.playVideo();
            this.scheduleAuthorizationCheck();
        }
    }

    pause(time) {
        if (this.player.getPlayerState() !== 2) {
            this.cancelAuthorizationCheck();
            this.player.pauseVideo();
            this.seek(time);
        }
    }

    stop() {
        this.cancelAuthorizationCheck();
        this.player.stopVideo();
    }

    seek(time) {
        if (typeof time === 'number' && this.ready) {
            this.player.seekTo(time);

            if (!this.props.playing) {
                this.player.pauseVideo();
                this.props.onTimeUpdate();
            }
        }
    }

    setVolume(volume) {
        this.player.setVolume(volume * 100);
    }

    scheduleAuthorizationCheck() {
        if (!this.authorizedOnce && this.authorizationTimeout === null) {
            this.authorizationTimeout = setTimeout(this.checkAuthorization, 2000);
        }
    }

    cancelAuthorizationCheck() {
        if (this.authorizationTimeout !== null) {
            clearTimeout(this.authorizationTimeout);
            this.authorizationTimeout = null;
        }
    }

    checkAuthorization() {
        this.authorizationTimeout = null;

        if (this.player && this.player.getPlayerState() === 1) {
            this.onAuthorized();
        } else {
            this.onNotAuthorized();
        }
    }

    onAuthorized() {
        this.authorizedOnce = true;

        if (!this.props.authorized) {
            this.props.setAuthorized(true);
        }
    }

    onNotAuthorized() {
        if (this.props.authorized) {
            this.props.setAuthorized(false);
        }
    }

    onUpdate() {
        this.props.onTimeUpdate();
        this.props.onProgress();
    }

    onResize() {
        if (this.ready) {
            this.player.setSize(window.innerWidth, window.innerHeight);
        }
    }

    onReady() {
        this.ready = true;
        this.props.setName(this.player.getVideoData().title);
        this.props.setLoaded(true);
        this.setVolume(this.props.volume);
        this.onDurationChange();
        this.loop.start();
    }

    onStateChange(event) {
        switch (event.data) {
            case YT.PlayerState.ENDED:
                // this.loop.stop();
                this.props.end();
                this.props.onEnded();
                break;
            case YT.PlayerState.PLAYING:
                /* if (!this.props.loaded) {
                    this.props.setLoaded(true);
                }*/
                this.props.onPlayed();
                // this.loop.start();
                break;
            case YT.PlayerState.PAUSED:
                // this.loop.stop();
                this.props.onPaused();
                break;
            default:
                break;
        }
    }

    onDurationChange() {
        this.props.setDuration(this.duration);
        this.props.onDurationChange();
    }

    onError(event, data) {
        console.error('onError', event, data);
    }

    getEmbedUrl() {
        const { src } = this.props;
        const parts = [];

        for (let key in this.options) {
            parts.push(`${key}=${this.options[key]}`);
        }

        return `https://www.youtube.com/embed/${src}?${parts.join('&')}`;
    }

    render() {
        return <iframe
            ref={this.setElement}
            className="youtube-player"
            id="youtube-player"
            type="text/html"
            width={window.innerWidth}
            height={window.innerHeight}
            src={this.getEmbedUrl()}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
            frameBorder="0"
        />;
    }
}
