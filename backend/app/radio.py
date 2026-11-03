"""网络电台：一个所有人都听同一首歌、同一位置的频道。

不是「每人一个播放器」，而是「一台发射机」：服务器持有一条排期——排好的曲目顺序、
每首的时长、以及这一轮的起始时刻——当前播到哪首、播到第几秒，全由「现在几点」
算出来。任何客户端带着自己的时钟误差去问一次，就能落回同一个位置。

这也是为什么必须有 ``_probe_duration``：没有时长就没有时间轴，谁也同步不了。
mp3 / wav / flac / ogg（Vorbis、Opus）精确解析，其它格式退回按文件大小估算
（不精确，但不会崩）。

另外三件事：

- **扫描目录、给出曲目清单、按 id 流式返回文件**。不解析除 TIT2/TPE1 之外的标签。
- **读标签是为了曲名**：从音乐 App 缓存下来的文件常叫 ``M800000dB5PY0Fmiev.mp3``，
  只按文件名显示等于没有曲名。标签按 mtime 缓存，重扫不会重复读盘。
- **对外只暴露曲目 id**：id 是相对路径的哈希，客户端拿不到文件系统结构，也就没有
  拼接 ``../../`` 做目录穿越的余地。
"""

from __future__ import annotations

import hashlib
import struct
import time
from bisect import bisect_right
from pathlib import Path

AUDIO_SUFFIXES = {".mp3", ".m4a", ".aac", ".ogg", ".oga", ".opus", ".flac", ".wav"}
MAX_TRACKS = 1000
# 目录内容不会频繁变化，列表请求又是每个客户端打开页面才发一次，
# 用几秒的缓存换掉「每来一个人就递归扫一遍」。
RESCAN_INTERVAL_SECONDS = 8.0
# ID3 头之后最多读这么多：文本帧几乎总在最前面，128KB 足够跨过一张封面图。
TAG_READ_LIMIT = 128 * 1024
# 估不出时长时的兜底，只为让排期还能往前走。
FALLBACK_BITRATE = 192_000

# MPEG 层 III 码率表（kbps），索引 0 与 15 是保留值。
_BITRATES_V1 = (0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0)
_BITRATES_V2 = (0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0)
_SAMPLE_RATES = {
    3: (44100, 48000, 32000, 0),  # MPEG 1
    2: (22050, 24000, 16000, 0),  # MPEG 2
    0: (11025, 12000, 8000, 0),   # MPEG 2.5
}


def _track_id(relative_path: str) -> str:
    return hashlib.sha1(relative_path.encode("utf-8")).hexdigest()[:12]


def _pretty_filename(path: Path) -> str:
    # 下载来的文件名常见 `歌手_曲名` 或 `歌手 - 曲名`，下划线换成空格即可读。
    return path.stem.replace("_", " ").strip() or path.name


# ----------------------------------------------------------------------
# ID3：只要曲名和艺术家
# ----------------------------------------------------------------------
def _syncsafe(raw: bytes) -> int:
    """ID3v2 的长度字段：每字节只用低 7 位。"""
    return (raw[0] << 21) | (raw[1] << 14) | (raw[2] << 7) | raw[3]


def _decode_text(encoding: int, payload: bytes) -> str:
    if encoding == 0:
        text = payload.decode("latin-1", "replace")
    elif encoding == 1:
        text = payload.decode("utf-16", "replace")
    elif encoding == 2:
        text = payload.decode("utf-16-be", "replace")
    else:
        text = payload.decode("utf-8", "replace")
    return text.replace("\x00", "").strip()


def read_tag_header(handle) -> tuple[int, int, int, bytes] | None:
    """读 ID3v2 头，返回 (主版本, 标志, 标签总长, 头部原始字节)。"""
    header = handle.read(10)
    if len(header) < 10 or header[:3] != b"ID3":
        return None
    return header[3], header[5], _syncsafe(header[6:10]), header


def read_tags(path: Path) -> dict[str, str]:
    """读出 TIT2（曲名）与 TPE1（艺术家）。解析不了就返回空字典。

    刻意不引入 mutagen：这里只需要两个文本帧，一个 40 行的读取器比一个新依赖
    划算，也不会在别人的机器上多一步 pip install。
    """
    try:
        with path.open("rb") as handle:
            parsed = read_tag_header(handle)
            if parsed is None:
                return {}
            version, flags, size, _ = parsed
            body = handle.read(min(size, TAG_READ_LIMIT))
    except OSError:
        return {}

    offset = 0
    if flags & 0x40 and len(body) >= 4:
        # 扩展头：v2.3 的长度含自身 4 字节，v2.4 不含。少见的写法，尽力而为。
        extended = int.from_bytes(body[0:4], "big")
        offset = extended + (4 if version < 4 else 0)

    tags: dict[str, str] = {}
    while offset + 10 <= len(body):
        frame_id = body[offset:offset + 4]
        if not frame_id.strip(b"\x00"):
            break  # 补零填充，后面的都不必看了
        raw_size = body[offset + 4:offset + 8]
        frame_size = _syncsafe(raw_size) if version >= 4 else int.from_bytes(raw_size, "big")
        if frame_size <= 0:
            break
        data = body[offset + 10:offset + 10 + frame_size]
        if len(data) < 1:
            break
        if frame_id in (b"TIT2", b"TPE1") and len(data) > 1:
            text = _decode_text(data[0], data[1:])
            if text:
                tags[frame_id.decode("ascii")] = text
        offset += 10 + frame_size
    return tags


def describe(path: Path) -> tuple[str, str]:
    """返回 (曲名, 艺术家)。标签优先，文件名兜底。"""
    tags = read_tags(path)
    title = tags.get("TIT2", "").strip()
    artist = tags.get("TPE1", "").strip()
    # 一首歌的艺术家字段常是 `A/B/feat.C` 这种串，卡片只有一行，取第一个。
    if "/" in artist:
        artist = artist.split("/", 1)[0].strip()
    return title or _pretty_filename(path), artist


# ----------------------------------------------------------------------
# 时长：没有它就没有时间轴
# ----------------------------------------------------------------------
def _mp3_duration(handle, audio_offset: int, audio_bytes: int) -> float:
    handle.seek(audio_offset)
    chunk = handle.read(16 * 1024)
    start = -1
    for index in range(len(chunk) - 4):
        if chunk[index] == 0xFF and (chunk[index + 1] & 0xE0) == 0xE0:
            start = index
            break
    if start < 0:
        return 0.0

    header = chunk[start:start + 4]
    version_bits = (header[1] >> 3) & 0x03
    layer = (header[1] >> 1) & 0x03
    if version_bits == 1 or layer != 0x01:  # 保留版本，或不是第 III 层
        return 0.0
    bitrate_index = (header[2] >> 4) & 0x0F
    rate_index = (header[2] >> 2) & 0x03
    padding = (header[2] >> 1) & 0x01
    mode = (header[3] >> 6) & 0x03

    table = _BITRATES_V1 if version_bits == 3 else _BITRATES_V2
    bitrate = table[bitrate_index] * 1000
    sample_rate = _SAMPLE_RATES[version_bits][rate_index]
    samples_per_frame = 1152 if version_bits == 3 else 576
    if bitrate <= 0 or sample_rate <= 0:
        return 0.0

    # Xing / Info 头：VBR 文件里记录总帧数，比按码率估算准得多。
    if version_bits == 3:
        side_info = 17 if mode == 0x03 else 32
    else:
        side_info = 9 if mode == 0x03 else 17
    frame_start = start
    tag_offset = frame_start + 4 + side_info
    marker = chunk[tag_offset:tag_offset + 4]
    if marker in (b"Xing", b"Info") and len(chunk) >= tag_offset + 12:
        flags = int.from_bytes(chunk[tag_offset + 4:tag_offset + 8], "big")
        if flags & 0x01:
            frames = int.from_bytes(chunk[tag_offset + 8:tag_offset + 12], "big")
            if frames > 0:
                return frames * samples_per_frame / sample_rate

    # 常量码率：字节数 / 每秒字节数。补一个帧的 padding 误差可以忽略。
    frame_bytes = (samples_per_frame // 8) * bitrate // sample_rate + padding
    remaining = max(0, audio_bytes - frame_start)
    if frame_bytes > 0:
        return remaining / frame_bytes * samples_per_frame / sample_rate
    return remaining * 8 / bitrate


def _wav_duration(handle) -> float:
    handle.seek(0)
    data = handle.read(64 * 1024)
    if data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        return 0.0
    offset = 12
    byte_rate = 0
    data_size = 0
    while offset + 8 <= len(data):
        chunk_id = data[offset:offset + 4]
        size = int.from_bytes(data[offset + 4:offset + 8], "little")
        if chunk_id == b"fmt " and offset + 20 <= len(data):
            # fmt 块里：8 格式 / 10 声道 / 12 采样率 / 16 每秒字节数
            byte_rate = int.from_bytes(data[offset + 16:offset + 20], "little")
        elif chunk_id == b"data":
            data_size = size
            break
        offset += 8 + size + (size & 1)
    if byte_rate <= 0:
        return 0.0
    return data_size / byte_rate


def _flac_duration(handle) -> float:
    handle.seek(0)
    header = handle.read(4 + 4 + 34)
    if header[:4] != b"fLaC" or len(header) < 42:
        return 0.0
    block = header[8:42]  # STREAMINFO
    packed = int.from_bytes(block[10:18], "big")
    sample_rate = packed >> 44
    total_samples = packed & ((1 << 36) - 1)
    if sample_rate <= 0 or total_samples <= 0:
        return 0.0
    return total_samples / sample_rate


# Ogg 页头固定 27 字节：capture pattern / 版本 / 头类型 / granule(8) / serial(4) /
# 页序(4) / crc(4) / 段数(1)，紧跟段数那么多字节的段表（每段最多 255 字节）。
_OGG_HEADER_BYTES = 27
# 识别头在第一页，末尾的 granule 在最后一页：两头各读一小段就够，不必读整首歌。
# 一页最大 27 + 255 + 255×255 ≈ 63.8KB，留一倍余量，免得最大的那页跨在窗口外。
_OGG_HEAD_BYTES = 8 * 1024
_OGG_TAIL_BYTES = 128 * 1024


def _ogg_page_bytes(buffer: bytes, offset: int) -> int:
    """返回从 offset 开始的这一页总长；页头/段表不完整时返回 0。"""
    if offset + _OGG_HEADER_BYTES > len(buffer):
        return 0
    segments = buffer[offset + 26]
    table_end = offset + _OGG_HEADER_BYTES + segments
    if table_end > len(buffer):
        return 0
    return _OGG_HEADER_BYTES + segments + sum(buffer[offset + 27:table_end])


def _ogg_last_granule(handle, size: int) -> int:
    """从文件尾部找最后一页的 granule（该流到此刻为止的总样本数）。

    倒着找 ``OggS`` 不够——压缩数据里完全可能出现这四个字节。所以要求这一页
    「正好结束在文件末尾」：偏移 + 段表长度 == 文件大小，才算真的最后一页。
    """
    handle.seek(max(0, size - _OGG_TAIL_BYTES))
    tail = handle.read()
    tail_start = size - len(tail)
    cursor = len(tail)
    while True:
        index = tail.rfind(b"OggS", 0, cursor)
        if index < 0:
            return 0
        length = _ogg_page_bytes(tail, index)
        if length and tail_start + index + length == size:
            # granule 是带符号的：-1 表示这一页没有收完任何一包。
            return max(0, int.from_bytes(tail[index + 6:index + 14], "little", signed=True))
        cursor = index


def _ogg_duration(handle) -> float:
    """Ogg Vorbis / Opus 的时长：末页 granule ÷ 采样率。

    这是一条必须准的路径：时间轴按「服务端认为的时长」排，估错一半，歌就会在
    一半处被判定「该换下一首」而直接切掉。所以宁可解析失败退回估算，也不要瞎猜。
    """
    handle.seek(0, 2)
    size = handle.tell()
    handle.seek(0)
    head = handle.read(_OGG_HEAD_BYTES)
    if len(head) < _OGG_HEADER_BYTES or head[:4] != b"OggS":
        return 0.0

    # 识别包紧跟在第一页的段表之后。
    payload = _OGG_HEADER_BYTES + head[26]
    sample_rate = 0
    pre_skip = 0
    if head[payload:payload + 7] == b"\x01vorbis" and len(head) >= payload + 16:
        # 0x01 "vorbis" / 版本(4) / 声道(1) / 采样率(4)
        sample_rate = int.from_bytes(head[payload + 12:payload + 16], "little")
    elif head[payload:payload + 8] == b"OpusHead" and len(head) >= payload + 12:
        # Opus 的 granule 恒定按 48kHz 计，与头里记录的输入采样率无关；
        # 开头那段 pre-skip 不算进时长。
        sample_rate = 48000
        pre_skip = int.from_bytes(head[payload + 10:payload + 12], "little")
    if sample_rate <= 0:
        return 0.0

    samples = _ogg_last_granule(handle, size) - pre_skip
    if samples <= 0:
        return 0.0
    return samples / sample_rate


def probe_duration(path: Path) -> float:
    """返回时长（秒）。估不出来就按 192kbps 粗算，至少让排期能往前走。"""
    try:
        size = path.stat().st_size
        with path.open("rb") as handle:
            suffix = path.suffix.lower()
            if suffix == ".wav":
                duration = _wav_duration(handle)
            elif suffix == ".flac":
                duration = _flac_duration(handle)
            elif suffix in (".ogg", ".oga", ".opus"):
                duration = _ogg_duration(handle)
            else:
                parsed = read_tag_header(handle)
                tag_size = 10 + parsed[2] if parsed else 0
                duration = _mp3_duration(handle, tag_size, size - tag_size)
    except OSError:
        return 0.0
    if duration <= 0.5:
        duration = size * 8 / FALLBACK_BITRATE
    return round(min(duration, 4 * 3600), 3)


class RadioLibrary:
    def __init__(self, directory: Path):
        self.directory = directory
        self._tracks: list[dict] = []
        self._paths: dict[str, Path] = {}
        # 标签与时长按 (mtime, size) 缓存：重扫目录时只读新文件。
        self._meta: dict[str, tuple[int, int, tuple[str, str], float]] = {}
        self._scanned_at = 0.0
        self._scanned = False
        # 排期：这一轮从 epoch 开始，按 _offsets 依次播放，_total 秒一轮。
        self._epoch = 0.0
        self._offsets: list[float] = []
        self._total = 0.0
        self._schedule_key: tuple = ()

    # ------------------------------------------------------------------
    # 扫描
    # ------------------------------------------------------------------
    def _describe(self, path: Path, stat_result) -> tuple[str, str, float]:
        key = str(path)
        cached = self._meta.get(key)
        if cached and cached[0] == stat_result.st_mtime_ns and cached[1] == stat_result.st_size:
            return cached[2][0], cached[2][1], cached[3]
        title, artist = describe(path)
        duration = probe_duration(path)
        self._meta[key] = (stat_result.st_mtime_ns, stat_result.st_size, (title, artist), duration)
        return title, artist, duration

    def _scan(self) -> None:
        tracks: list[dict] = []
        paths: dict[str, Path] = {}
        seen: set[str] = set()
        root = self.directory
        if root.is_dir():
            files = [
                path for path in root.rglob("*")
                if path.is_file()
                and path.suffix.lower() in AUDIO_SUFFIXES
                and not path.name.startswith(".")
            ]
            files.sort(key=lambda path: path.name.casefold())
            for path in files[:MAX_TRACKS]:
                relative = path.relative_to(root).as_posix()
                track_id = _track_id(relative)
                try:
                    stat_result = path.stat()
                except OSError:
                    continue
                title, artist, duration = self._describe(path, stat_result)
                tracks.append({
                    "id": track_id,
                    "title": title,
                    "artist": artist,
                    # 低于 1 秒的时长（探测失败/极短片段）没有意义，统一抬到 1 秒：
                    # 客户端会用同一个数算时间轴，两边必须一致。
                    "durationMs": max(int(duration * 1000), 1000),
                })
                paths[track_id] = path
                seen.add(str(path))
        # 删掉已经不存在的文件，缓存不会跟着目录一起膨胀。
        if len(self._meta) > len(seen):
            self._meta = {key: value for key, value in self._meta.items() if key in seen}
        # 先记下「现在放到哪了」，再换名单——换完之后就推不回去了。
        playing = self._position_at(time.time()) if (self._epoch > 0 and self._tracks) else None
        self._tracks = tracks
        self._paths = paths
        self._schedule(playing)
        self._scanned_at = time.monotonic()
        self._scanned = True

    def _schedule(self, playing: tuple[str, float] | None) -> None:
        """重排时间轴。曲目没变就沿用原来的起点，变了就把正在播的那首原位接上。"""
        if not self._tracks:
            self._epoch = 0.0
            self._offsets = []
            self._total = 0.0
            self._schedule_key = ()
            return

        key = tuple((track["id"], track["durationMs"]) for track in self._tracks)
        offsets: list[float] = []
        cursor = 0.0
        for track in self._tracks:
            offsets.append(cursor)
            cursor += track["durationMs"] / 1000
        if key == self._schedule_key and self._epoch > 0:
            self._offsets = offsets
            self._total = cursor
            return

        self._offsets = offsets
        self._total = cursor
        self._schedule_key = key
        now = time.time()
        if playing is not None:
            track_id, position = playing
            index = next((i for i, track in enumerate(self._tracks) if track["id"] == track_id), None)
            if index is not None:
                # 让这首继续播下去，前后顺序换成新的。
                self._epoch = now - (offsets[index] + position)
                return
        self._epoch = now

    # ------------------------------------------------------------------
    # 排期查询
    # ------------------------------------------------------------------
    def _ensure_fresh(self) -> None:
        if not self._scanned or time.monotonic() - self._scanned_at > RESCAN_INTERVAL_SECONDS:
            self._scan()

    def refresh(self) -> None:
        """立刻重扫。测试与「刚丢进来一首歌」的场合用得到。"""
        self._scan()

    def _position_at(self, now: float) -> tuple[str, float] | None:
        if not self._tracks or self._total <= 0:
            return None
        elapsed = (now - self._epoch) % self._total
        index = bisect_right(self._offsets, elapsed) - 1
        index = max(0, min(index, len(self._tracks) - 1))
        return self._tracks[index]["id"], elapsed - self._offsets[index]

    def station(self, now: float | None = None) -> dict:
        now = time.time() if now is None else now
        current = self._position_at(now)
        return {
            "startedAtMs": int(self._epoch * 1000),
            "serverNowMs": int(now * 1000),
            "totalMs": int(self._total * 1000),
            "trackId": current[0] if current else None,
            "positionMs": int(current[1] * 1000) if current else 0,
            "trackCount": len(self._tracks),
        }

    @property
    def count(self) -> int:
        self._ensure_fresh()
        return len(self._tracks)

    def snapshot(self) -> dict:
        self._ensure_fresh()
        return {"enabled": bool(self._tracks), "station": self.station(), "tracks": self._tracks}

    def state(self) -> dict:
        """只回答「现在是哪首、第几秒」，给客户端定期校准用，不重复发整张曲库。"""
        self._ensure_fresh()
        return self.station()

    def path_for(self, track_id: str) -> Path | None:
        self._ensure_fresh()
        path = self._paths.get(track_id)
        if path is None or not path.is_file():
            return None
        return path
