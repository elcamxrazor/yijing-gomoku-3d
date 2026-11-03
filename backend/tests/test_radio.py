import time

from fastapi.testclient import TestClient

from app.main import create_app


def id3_tag(frames: dict[str, str]) -> bytes:
    """拼一个最小的 ID3v2.3 标签：只有文本帧，编码统一用 UTF-8（0x03）。"""
    body = b""
    for frame_id, text in frames.items():
        payload = b"\x03" + text.encode("utf-8")
        body += frame_id.encode("ascii") + len(payload).to_bytes(4, "big") + b"\x00\x00" + payload
    size = len(body)
    syncsafe = bytes([(size >> 21) & 0x7F, (size >> 14) & 0x7F, (size >> 7) & 0x7F, size & 0x7F])
    return b"ID3\x03\x00\x00" + syncsafe + body


EMPTY_TAG = b"ID3\x03\x00\x00\x00\x00\x00\x00"


def make_track(path, size: int = 4096, tags: dict[str, str] | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    # 内容无所谓，接口只负责原样搬运字节；长度必须精确，Range 断言要对着它算。
    head = id3_tag(tags) if tags else EMPTY_TAG
    path.write_bytes((head + bytes(range(256)) * (size // 256 + 1))[:size])


def make_cbr_mp3(path, seconds: float, tags: dict[str, str] | None = None) -> int:
    """写一个「128kbps / 44.1kHz / 立体声」的常量码率 mp3 外壳（只有帧头是真的）。"""
    frame_bytes = 144 * 128_000 // 44_100
    frame_seconds = 1152 / 44_100
    frames = max(1, round(seconds / frame_seconds))
    header = bytes([0xFF, 0xFB, 0x90, 0x00])
    audio = header + b"\x00" * (frame_bytes * frames - 4)
    tag = id3_tag(tags) if tags else b""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(tag + audio)
    return frames


def make_wav(path, seconds: float, rate: int = 8000) -> None:
    frames = int(rate * seconds)
    data = b"\x00\x00" * frames
    fmt = b"fmt " + (16).to_bytes(4, "little") + (1).to_bytes(2, "little")
    fmt += (1).to_bytes(2, "little") + rate.to_bytes(4, "little")
    fmt += (rate * 2).to_bytes(4, "little") + (2).to_bytes(2, "little") + (16).to_bytes(2, "little")
    body = b"WAVE" + fmt + b"data" + len(data).to_bytes(4, "little") + data
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"RIFF" + len(body).to_bytes(4, "little") + body)


def ogg_page(payload: bytes, granule: int, header_type: int = 0) -> bytes:
    """拼一个最小的 Ogg 页。解析器不校验 CRC，这里留零即可。"""
    segments = [255] * (len(payload) // 255) + [len(payload) % 255]
    return (
        b"OggS" + bytes([0, header_type])
        + granule.to_bytes(8, "little", signed=True)
        + (1).to_bytes(4, "little") + (0).to_bytes(4, "little") + b"\x00\x00\x00\x00"
        + bytes([len(segments)]) + bytes(segments) + payload
    )


def make_ogg(path, seconds: float, rate: int = 44100) -> None:
    """写一个 Vorbis 外壳：首页放识别头，末页 granule 放总样本数。"""
    # 0x01 "vorbis" / 版本(4) / 声道(1) / 采样率(4) / 三个码率字段(12)
    ident = b"\x01vorbis" + (0).to_bytes(4, "little") + bytes([2])
    ident += rate.to_bytes(4, "little") + b"\x00" * 12
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(
        ogg_page(ident, 0, header_type=0x02)
        + ogg_page(b"\x00" * 400, 1000)
        + ogg_page(b"\x00" * 200, int(rate * seconds), header_type=0x04)
    )


def make_opus(path, seconds: float, pre_skip: int = 3840) -> None:
    """Opus 的 granule 恒按 48kHz 计，且要扣掉 pre-skip。"""
    ident = b"OpusHead" + bytes([1, 2]) + pre_skip.to_bytes(2, "little")
    ident += (48000).to_bytes(4, "little")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(
        ogg_page(ident, 0, header_type=0x02)
        + ogg_page(b"\x00" * 120, int(48000 * seconds) + pre_skip, header_type=0x04)
    )


def radio_app(settings, directory):
    tuned = settings.model_copy(update={"radio_dir": str(directory)})
    return create_app(tuned)


def test_radio_lists_tracks_and_streams_bytes(tmp_path, settings):
    music = tmp_path / "music"
    # 带 ID3 标签的用标签里的曲名与艺术家；没有标签的退回文件名。
    make_track(music / "夜航星.mp3", 4096, {"TIT2": "夜航星", "TPE1": "木星/另一个名字"})
    make_track(music / "雨落_古琴.flac", 2048)
    make_track(music / "cover.jpg")  # 非音频文件必须被忽略
    app = radio_app(settings, music)

    with TestClient(app) as client:
        index = client.get("/api/radio")
        assert index.status_code == 200
        payload = index.json()
        assert payload["enabled"] is True
        tracks = payload["tracks"]
        # 按文件名排序；下划线换成空格；封面图不出现。
        assert [track["title"] for track in tracks] == ["夜航星", "雨落 古琴"]
        # 艺术家字段是 `A/B` 这种串时只取第一个，卡片只有一行。
        assert [track["artist"] for track in tracks] == ["木星", ""]
        assert all(track["id"] for track in tracks)

        first = tracks[0]
        full = client.get(f"/api/radio/{first['id']}")
        assert full.status_code == 200
        assert len(full.content) == 4096
        assert full.headers["accept-ranges"] == "bytes"
        assert full.headers["content-type"].startswith("audio/mpeg")

        # 浏览器拖动进度会发 Range，服务端必须回 206 + Content-Range。
        part = client.get(f"/api/radio/{first['id']}", headers={"Range": "bytes=100-199"})
        assert part.status_code == 206
        assert len(part.content) == 100
        assert part.headers["content-range"] == "bytes 100-199/4096"

        assert client.get("/api/radio/does-not-exist").status_code == 404


def test_radio_probes_durations_for_the_timeline(tmp_path, settings):
    music = tmp_path / "music"
    make_cbr_mp3(music / "ten.mp3", 10.0, {"TIT2": "十秒"})
    make_wav(music / "two.wav", 2.0)
    app = radio_app(settings, music)

    with TestClient(app) as client:
        tracks = client.get("/api/radio").json()["tracks"]
        by_title = {track["title"]: track for track in tracks}
        # 常量码率按「字节数 / 每秒字节数」算，误差在一个帧以内。
        assert abs(by_title["十秒"]["durationMs"] - 10_000) < 300
        # wav 直接读 fmt/data 头，应该是准的。
        assert abs(by_title["two"]["durationMs"] - 2_000) < 50
        # 低于 1 秒的时长统一抬到 1 秒，客户端与服务器必须用同一个数。
        assert all(track["durationMs"] >= 1000 for track in tracks)


def test_radio_reads_ogg_granule_for_exact_duration(tmp_path, settings):
    music = tmp_path / "music"
    make_ogg(music / "vorbis.ogg", 120.0)
    # 文件名里的下划线会被换成空格，这里避开，免得曲名和断言对不上。
    make_ogg(music / "second.oga", 30.0, rate=48000)
    make_opus(music / "opus.opus", 90.0)
    app = radio_app(settings, music)

    with TestClient(app) as client:
        tracks = {track["title"]: track for track in client.get("/api/radio").json()["tracks"]}
        # 末页 granule 就是总样本数：不准的话，歌会在时间轴上被提前切掉。
        assert abs(tracks["vorbis"]["durationMs"] - 120_000) < 50
        assert abs(tracks["second"]["durationMs"] - 30_000) < 50
        # Opus 按 48kHz 折算，并扣掉 pre-skip。
        assert abs(tracks["opus"]["durationMs"] - 90_000) < 50


def test_radio_station_keeps_everyone_on_the_same_clock(tmp_path, settings):
    music = tmp_path / "music"
    make_cbr_mp3(music / "a.mp3", 10.0, {"TIT2": "A"})
    make_cbr_mp3(music / "b.mp3", 10.0, {"TIT2": "B"})
    app = radio_app(settings, music)

    with TestClient(app) as client:
        payload = client.get("/api/radio").json()
        station = payload["station"]
        assert payload["enabled"] is True
        assert station["trackCount"] == 2
        assert station["totalMs"] == sum(track["durationMs"] for track in payload["tracks"])
        assert station["trackId"] in {track["id"] for track in payload["tracks"]}

        time.sleep(1.2)
        later = client.get("/api/radio/state").json()
        # 排期起点不动，位置随时钟前进——这就是「同一个电台」的全部秘密。
        assert later["startedAtMs"] == station["startedAtMs"]
        assert later["serverNowMs"] - station["serverNowMs"] >= 1000
        # 两首都是 10 秒，1.2 秒内一定不会换歌。
        assert later["trackId"] == station["trackId"]
        assert later["positionMs"] - station["positionMs"] >= 900


def test_radio_is_off_when_directory_is_missing_or_empty(tmp_path, settings):
    empty = tmp_path / "radio"
    empty.mkdir()
    with TestClient(radio_app(settings, empty)) as client:
        payload = client.get("/api/radio").json()
        assert payload["enabled"] is False
        assert payload["tracks"] == []
        assert payload["station"]["trackId"] is None

    missing = tmp_path / "nope"
    with TestClient(radio_app(settings, missing)) as client:
        assert client.get("/api/radio").json()["enabled"] is False


def test_radio_picks_up_new_files_without_restart(tmp_path, settings):
    music = tmp_path / "music"
    music.mkdir()
    app = radio_app(settings, music)

    with TestClient(app) as client:
        assert client.get("/api/radio").json()["enabled"] is False
        make_cbr_mp3(music / "later.mp3", 3.0)
        # 扫描结果有 8 秒缓存，绕过它等价于「过了缓存期」。
        app.state.radio.refresh()
        payload = client.get("/api/radio").json()
        assert payload["enabled"] is True
        assert payload["tracks"][0]["title"] == "later"
