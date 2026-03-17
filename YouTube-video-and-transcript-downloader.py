import subprocess
import re
import os
import platform
from pathlib import Path
import tkinter as tk
from tkinter import ttk, messagebox, filedialog, scrolledtext
import threading
import sys
import time
import json
import urllib.request
import urllib.parse
import xml.etree.ElementTree as ET
# Timedtext retrieval and GUI update 010126: https://claude.ai/chat/410b08a3-4664-4ed8-b179-17301e8c7072
# Re-ticking Cookies: True on 010226
# Hyphenated language code fix 170326
# ==================== CONFIGURATION ====================
CONFIG = {
    # Available languages with their full names
    "available_languages": {
        "hu": "Hungarian",
        "en": "English",
        "it": "Italian",
        "de": "German",
        "fr": "French",
        "es": "Spanish",
        "pt": "Portuguese",
        "ru": "Russian",
        "ja": "Japanese",
        "ko": "Korean",
        "zh": "Chinese"
    },
    
    # Default language priority order (can be customized)
    "default_language_order": ["hu", "en", "it", "de"],
    
    "try_auto_first": True,  # Try automatic subtitles first
    
    "subtitle_format": "vtt",  # or "srt"
    "output_filename_format": "{video_id}_{lang}.md",
    
    # Video download settings
    "max_resolution": "1080",
    "video_format": "mp4",
    "audio_quality": "best",
    
    # Anti-block settings
    "use_cookies": False,
    "cookies_browser": "firefox",
    "cookies_file_path": None,
    "retry_attempts": 3,
    "retry_delay": 2,
    
    # NEW: TimedText fallback settings
    "use_timedtext_fallback": True,  # Try direct timedtext API when yt-dlp fails
    "accept_any_language": False,  # Accept any available language if preferred ones not found
}
# Set root directory based on platform using pathlib
if platform.system() == "Windows":
    BASE_PATH = Path.home() / "Downloads"
elif platform.system() == "Linux":
    BASE_PATH = Path.home() / "Downloads"
else:
    BASE_PATH = Path.home() / "Downloads"
BASE_PATH = str(BASE_PATH)


def lang_matches(track_lang_code, preferred_lang):
    """
    Check if a track language code matches a preferred base language code.
    Handles hyphenated variants: 'en' matches 'en-GB', 'en-US', 'en-gb', etc.
    Also handles underscore variants: 'zh_Hans', 'pt_BR', etc.
    Case-insensitive comparison.
    """
    track = track_lang_code.lower().replace('_', '-')
    preferred = preferred_lang.lower().replace('_', '-')
    # Exact match
    if track == preferred:
        return True
    # Variant match: track starts with preferred + hyphen (e.g. 'en-gb' starts with 'en-')
    if track.startswith(preferred + '-'):
        return True
    return False


def check_yt_dlp():
    """Check if yt-dlp is installed and yt-dlp-ejs component is available."""
    try:
        result = subprocess.run(["yt-dlp", "--version"],
                                capture_output=True, text=True, check=True)
        version = result.stdout.strip()
        ejs_available = False
        try:
            import importlib.util
            ejs_available = importlib.util.find_spec("yt_dlp_ejs") is not None
        except Exception:
            pass
        return True, version, ejs_available
    except (subprocess.CalledProcessError, FileNotFoundError):
        return False, None, False


def extract_video_id(url):
    """Extract video ID from various YouTube URL formats."""
    url = re.sub(r'[&?]list=[^&]*', '', url)
    
    patterns = [
        r'(?:youtube\.com/watch\?.*v=|youtu\.be/)([0-9A-Za-z_-]{11})',
        r'youtube\.com/embed/([0-9A-Za-z_-]{11})',
        r'youtube\.com/v/([0-9A-Za-z_-]{11})',
        r'youtube\.com/shorts/([0-9A-Za-z_-]{11})',
        r'youtube\.com/live/([0-9A-Za-z_-]{11})',
        r'(?:m\.youtube\.com/watch\?.*v=)([0-9A-Za-z_-]{11})',
        r'(?:gaming\.youtube\.com/watch\?.*v=)([0-9A-Za-z_-]{11})',
    ]
    
    for pattern in patterns:
        match = re.search(pattern, url)
        if match:
            video_id = match.group(1)
            if re.match(r'^[0-9A-Za-z_-]{11}$', video_id):
                return video_id
    
    return None


def get_available_captions_timedtext(video_url, progress_callback=None):
    """Get available captions directly from YouTube's timedtext API."""
    video_id = extract_video_id(video_url)
    if not video_id:
        raise ValueError("Could not extract video ID from URL")
    
    if progress_callback:
        progress_callback("Fetching available captions from YouTube...")
    
    try:
        # Get video page to extract caption tracks
        watch_url = f"https://www.youtube.com/watch?v={video_id}"
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
        
        req = urllib.request.Request(watch_url, headers=headers)
        with urllib.request.urlopen(req, timeout=10) as response:
            html = response.read().decode('utf-8')
        
        # Extract caption tracks from player response
        caption_tracks = []
        
        # Look for captionTracks in the page
        pattern = r'"captionTracks":\s*(\[.*?\])'
        match = re.search(pattern, html)
        
        if match:
            try:
                tracks_json = match.group(1)
                # Fix common JSON issues
                tracks_json = tracks_json.replace('\\"', '"')
                tracks = json.loads(tracks_json)
                
                for track in tracks:
                    lang_code = track.get('languageCode', 'unknown')
                    lang_name = track.get('name', {}).get('simpleText', lang_code)
                    base_url = track.get('baseUrl', '')
                    is_auto = track.get('kind', '') == 'asr'
                    
                    caption_tracks.append({
                        'lang_code': lang_code,
                        'lang_name': lang_name,
                        'base_url': base_url,
                        'is_auto': is_auto
                    })
            except json.JSONDecodeError:
                pass
        
        return caption_tracks, video_id
        
    except Exception as e:
        raise RuntimeError(f"Failed to fetch caption list: {str(e)}")


def download_timedtext_captions(base_url, video_id, lang_code, video_title, is_auto=False, progress_callback=None):
    """Download captions directly from timedtext API."""
    if progress_callback:
        lang_type = "auto-generated" if is_auto else "manual"
        progress_callback(f"Downloading {lang_code} ({lang_type}) via timedtext API...")
    
    try:
        # Add format parameter to get JSON3 format (easier to parse)
        if '?' in base_url:
            url = f"{base_url}&fmt=json3"
        else:
            url = f"{base_url}?fmt=json3"
        
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer': 'https://www.youtube.com/'
        }
        
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=15) as response:
            data = json.loads(response.read().decode('utf-8'))
        
        # Parse JSON3 format
        lines = []
        events = data.get('events', [])
        
        for event in events:
            if 'segs' not in event:
                continue
            
            start_ms = event.get('tStartMs', 0)
            start_sec = start_ms / 1000
            
            h = int(start_sec // 3600)
            m = int((start_sec % 3600) // 60)
            s = int(start_sec % 60)
            ts_str = f"{h:02}:{m:02}:{s:02}"
            
            total_seconds = int(start_sec)
            yt_url = f"https://www.youtube.com/watch?v={video_id}&t={total_seconds}"
            
            # Combine all segments
            text_parts = []
            for seg in event['segs']:
                if 'utf8' in seg:
                    text_parts.append(seg['utf8'])
            
            clean_text = ''.join(text_parts).strip()
            clean_text = re.sub(r'\s+', ' ', clean_text)
            
            if clean_text:
                lines.append(f"[{ts_str}]({yt_url}) {clean_text}")
        
        # Build transcript
        sub_type = "auto" if is_auto else "manual"
        sub_type_display = " (auto-generated)" if is_auto else ""
        
        header = f"# {video_title}\n\n"
        header += f"**Video ID:** {video_id}  \n"
        header += f"**Language:** {lang_code.upper()}{sub_type_display}  \n"
        header += f"**URL:** [Watch on YouTube](https://www.youtube.com/watch?v={video_id})  \n"
        header += f"**Source:** TimedText API  \n\n"
        header += "---\n\n"
        
        transcript = header + "\n".join(lines)
        return transcript, video_id, lang_code, video_title, sub_type
        
    except Exception as e:
        raise RuntimeError(f"Failed to download timedtext captions: {str(e)}")


def get_base_command_with_antiblock():
    """Build base yt-dlp command with anti-block measures."""
    cmd = ["yt-dlp"]
    
    # Add user-agent to mimic real browser
    cmd.extend(["--user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"])
    
    # Add cookies if enabled
    if CONFIG["use_cookies"]:
        if CONFIG["cookies_file_path"] and Path(CONFIG["cookies_file_path"]).exists():
            cmd.extend(["--cookies", CONFIG["cookies_file_path"]])
        else:
            cmd.extend(["--cookies-from-browser", CONFIG["cookies_browser"]])
    
    # Add referer header
    cmd.extend(["--add-header", "Referer:https://www.youtube.com/"])
    
    # Add extra sleep to avoid rate limiting
    cmd.extend(["--sleep-interval", "1"])
    cmd.extend(["--max-sleep-interval", "3"])
    
    return cmd


def get_video_title(video_url):
    """Get video title for better file naming."""
    for attempt in range(CONFIG["retry_attempts"]):
        try:
            cmd = get_base_command_with_antiblock()
            cmd.extend(["--get-title", video_url])
            
            result = subprocess.run(cmd, capture_output=True, text=True, check=True)
            return result.stdout.strip()
        except subprocess.CalledProcessError as e:
            if attempt < CONFIG["retry_attempts"] - 1:
                time.sleep(CONFIG["retry_delay"])
                continue
            return "Unknown_Title"
    return "Unknown_Title"


def clean_filename(title, max_length=40):
    """Clean filename with improved character handling."""
    title = re.sub(r'[<>:"/\\|?*]', '', title)
    title = re.sub(r'[^\w\s\-_.()]', '', title)
    title = re.sub(r'\s+', '_', title.strip())
    title = re.sub(r'_{2,}', '_', title)
    title = title.strip('_.-')
    
    if not title or len(title) < 3:
        return "video"
    
    return title[:max_length]


def download_video(video_url, output_path, max_res, progress_callback=None):
    """Download video from YouTube with improved progress messages."""
    output_dir = Path(output_path)
    video_id = extract_video_id(video_url)
    
    if not video_id:
        raise ValueError(f"Could not extract video ID from URL: {video_url}")
    
    if progress_callback:
        progress_callback("Getting video information...")
    
    video_title = get_video_title(video_url)
    clean_title = clean_filename(video_title)
    
    output_template = str(output_dir / f"{clean_title}_{video_id}.%(ext)s")
    
    if progress_callback:
        progress_callback(f"Downloading video (target: {max_res}p max)...")
    
    for attempt in range(CONFIG["retry_attempts"]):
        try:
            format_selector = f"bestvideo[height<={max_res}]+bestaudio/best[height<={max_res}]/best[height<={max_res}]/best"
            
            cmd = get_base_command_with_antiblock()
            cmd.extend([
                "-f", format_selector,
                "--merge-output-format", CONFIG["video_format"],
                "-o", output_template,
                "--no-playlist",
                video_url
            ])
            
            result = subprocess.run(cmd, check=True, capture_output=True, text=True, shell=False)
            
            possible_extensions = ['.mp4', '.webm', '.mkv', '.avi', '.mov', '.flv']
            for ext in possible_extensions:
                potential_file = output_dir / f"{clean_title}_{video_id}{ext}"
                if potential_file.exists():
                    return potential_file, video_title
            
            for file in output_dir.glob(f"*{video_id}*"):
                if file.suffix.lower() in possible_extensions:
                    return file, video_title
            
            current_time = time.time()
            for file in output_dir.iterdir():
                if (file.is_file() and 
                    file.suffix.lower() in ['.mp4', '.webm', '.mkv', '.avi', '.mov', '.flv'] and
                    abs(file.stat().st_mtime - current_time) < 300):
                    if video_id in file.name or clean_title in file.name:
                        return file, video_title
            
            error_msg = f"Download may have succeeded but file not found.\n"
            error_msg += f"Expected pattern: {clean_title}_{video_id}.*\n"
            error_msg += f"Search directory: {output_dir}\n"
            raise RuntimeError(error_msg)
            
        except subprocess.CalledProcessError as e:
            if attempt < CONFIG["retry_attempts"] - 1:
                if progress_callback:
                    progress_callback(f"Retry {attempt + 1}/{CONFIG['retry_attempts']} after error...")
                time.sleep(CONFIG["retry_delay"])
                continue
            error_msg = f"Download failed after {CONFIG['retry_attempts']} attempts: {e.stderr if e.stderr else 'Unknown error'}\n"
            raise RuntimeError(error_msg)


def find_subtitle_file(output_dir, video_id, lang, sub_type, fmt):
    """
    Find a subtitle file that matches the video_id and base language code.
    Handles hyphenated variants like en-GB, en-US, zh-Hans, pt-BR, etc.
    
    yt-dlp saves files as:
      manual:  {video_id}.{lang_code}.{fmt}          e.g. abc123.en-GB.vtt
      auto:    {video_id}.{lang_code}.auto.{fmt}     e.g. abc123.en.auto.vtt
               or {video_id}.{lang_code}.auto-generated.{fmt}
    """
    output_dir = Path(output_dir)

    if sub_type == "auto":
        # Match: video_id.<lang or lang-variant>.auto*.fmt
        # Glob all auto subtitle files for this video
        for candidate in output_dir.glob(f"{video_id}.*.{fmt}"):
            name = candidate.stem  # e.g. "abc123.en-GB.auto" or "abc123.en.auto-generated"
            parts = name.split('.')
            # parts[0] = video_id, parts[1] = lang_code, parts[2+] = "auto" or "auto-generated"
            if len(parts) >= 3 and lang_matches(parts[1], lang) and 'auto' in parts[2].lower():
                return candidate
    else:
        # Manual: video_id.<lang or lang-variant>.fmt
        # But NOT the auto ones (no "auto" in stem beyond lang code)
        for candidate in output_dir.glob(f"{video_id}.*.{fmt}"):
            name = candidate.stem  # e.g. "abc123.en-GB"
            parts = name.split('.')
            # parts[0] = video_id, parts[1] = lang_code, no further parts for manual
            if len(parts) == 2 and lang_matches(parts[1], lang):
                return candidate

    return None


def download_and_parse_subs(video_url, output_path, language_order, try_auto_first, progress_callback=None):
    """Download and parse subtitles from YouTube video with timedtext fallback."""
    output_dir = Path(output_path)
    output_template = str(output_dir / "%(id)s.%(ext)s")
    video_id = extract_video_id(video_url)
    
    if not video_id:
        raise ValueError(f"Could not extract video ID from URL: {video_url}")
    
    if progress_callback:
        progress_callback("Getting video information...")
    
    video_title = get_video_title(video_url)
    
    if try_auto_first:
        sub_types = [("auto", "auto-generated"), ("manual", "manual")]
    else:
        sub_types = [("manual", "manual"), ("auto", "auto-generated")]
    
    # Try yt-dlp first
    for lang in language_order:
        lang_name = CONFIG["available_languages"].get(lang, lang.upper())
        
        for sub_type, sub_type_name in sub_types:
            if progress_callback:
                progress_callback(f"Trying {lang_name} {sub_type_name} subtitles (yt-dlp)...")
            
            for attempt in range(CONFIG["retry_attempts"]):
                try:
                    cmd = get_base_command_with_antiblock()
                    fmt = CONFIG["subtitle_format"]

                    # Use wildcard lang spec so yt-dlp downloads en, en-GB, en-US, etc.
                    # yt-dlp accepts regex/glob in --sub-lang: "en.*" matches en, en-GB, en-US
                    lang_pattern = f"{lang}.*"

                    if sub_type == "auto":
                        cmd.extend([
                            "--write-auto-sub",
                            "--sub-lang", lang_pattern,
                            "--skip-download",
                            "--sub-format", fmt,
                            "-o", output_template,
                            video_url
                        ])
                    else:
                        cmd.extend([
                            "--write-sub",
                            "--sub-lang", lang_pattern,
                            "--skip-download",
                            "--sub-format", fmt,
                            "-o", output_template,
                            video_url
                        ])
                    
                    subprocess.run(cmd, check=True, capture_output=True, text=True, shell=False)
                    
                    # Find whichever variant file was actually downloaded
                    subtitle_file = find_subtitle_file(output_dir, video_id, lang, sub_type, fmt)

                    if subtitle_file and subtitle_file.exists():
                        # Record the actual language code that was downloaded (e.g. "en-GB")
                        actual_lang_code = subtitle_file.stem.split('.')[1] if '.' in subtitle_file.stem else lang

                        if progress_callback:
                            progress_callback(f"Processing {actual_lang_code} {sub_type_name} subtitles...")
                        
                        with open(subtitle_file, encoding="utf-8") as f:
                            content = f.read()
                        subtitle_file.unlink()
                        
                        lines = []
                        if fmt == "vtt":
                            blocks = re.findall(
                                r"(\d{2}:\d{2}:\d{2}\.\d{3})\s+-->\s+\d{2}:\d{2}:\d{2}\.\d{3}.*?\n(.*?)\n\n", 
                                content, re.DOTALL)
                        else:
                            blocks = re.findall(
                                r"\d+\n(\d{2}:\d{2}:\d{2},\d{3})\s+-->\s+\d{2}:\d{2}:\d{2},\d{3}.*?\n(.*?)\n\n", 
                                content, re.DOTALL)
                        
                        for start_time, text in blocks:
                            time_str = start_time.replace(',', '.')
                            try:
                                h, m, s = map(float, time_str.split(":"))
                                total_seconds = int(h * 3600 + m * 60 + s)
                                ts_str = f"{int(h):02}:{int(m):02}:{int(s):02}"
                                yt_url = f"https://www.youtube.com/watch?v={video_id}&t={total_seconds}"
                                clean_text = text.strip().replace('\n', ' ')
                                clean_text = re.sub(r'<[^>]*>', '', clean_text)
                                clean_text = re.sub(r'\s+', ' ', clean_text)
                                clean_text = clean_text.strip()
                                if clean_text:
                                    lines.append(f"[{ts_str}]({yt_url}) {clean_text}")
                            except (ValueError, IndexError):
                                continue
                        
                        sub_type_display = " (auto-generated)" if sub_type == "auto" else ""
                        header = f"# {video_title}\n\n"
                        header += f"**Video ID:** {video_id}  \n"
                        header += f"**Language:** {actual_lang_code.upper()}{sub_type_display}  \n"
                        header += f"**URL:** [Watch on YouTube]({video_url})  \n\n"
                        header += "---\n\n"
                        transcript = header + "\n".join(lines)
                        
                        return transcript, video_id, actual_lang_code, video_title, sub_type
                    
                    break
                    
                except subprocess.CalledProcessError as e:
                    if attempt < CONFIG["retry_attempts"] - 1:
                        if progress_callback:
                            progress_callback(f"Retrying {lang_name} {sub_type_name} (attempt {attempt + 2})...")
                        time.sleep(CONFIG["retry_delay"])
                        continue
                    break
    
    # If yt-dlp failed and timedtext fallback is enabled, try timedtext API
    if CONFIG["use_timedtext_fallback"]:
        if progress_callback:
            progress_callback("yt-dlp failed. Trying TimedText API fallback...")
        
        try:
            caption_tracks, video_id = get_available_captions_timedtext(video_url, progress_callback)
            
            if not caption_tracks:
                raise RuntimeError("No captions found via TimedText API either")
            
            # Try languages in preferred order, respecting auto/manual preference
            for lang in language_order:
                for is_auto in ([True, False] if try_auto_first else [False, True]):
                    # Use lang_matches() so en-GB is found when 'en' is requested
                    matching_tracks = [
                        t for t in caption_tracks
                        if lang_matches(t['lang_code'], lang) and t['is_auto'] == is_auto
                    ]
                    
                    if matching_tracks:
                        track = matching_tracks[0]
                        transcript, video_id, lang_code, video_title, sub_type = download_timedtext_captions(
                            track['base_url'], video_id, track['lang_code'], 
                            video_title, track['is_auto'], progress_callback
                        )
                        return transcript, video_id, lang_code, video_title, sub_type
            
            # If "accept any language" is enabled and no matching language found
            if CONFIG["accept_any_language"] and caption_tracks:
                if progress_callback:
                    progress_callback("No preferred languages found. Downloading first available language...")
                track = caption_tracks[0]
                transcript, video_id, lang_code, video_title, sub_type = download_timedtext_captions(
                    track['base_url'], video_id, track['lang_code'], 
                    video_title, track['is_auto'], progress_callback
                )
                return transcript, video_id, lang_code, video_title, sub_type
            
            # If no matching language found, return info about available captions
            available_langs = set([t['lang_code'] for t in caption_tracks])
            raise RuntimeError(f"Requested languages not available. Available: {', '.join(sorted(available_langs))}")
            
        except Exception as e:
            lang_names = ", ".join([CONFIG["available_languages"].get(l, l.upper()) for l in language_order])
            raise RuntimeError(f"No subtitles found via yt-dlp or TimedText API in: {lang_names}\n\nTimedText error: {str(e)}")
    
    lang_names = ", ".join([CONFIG["available_languages"].get(l, l.upper()) for l in language_order])
    raise RuntimeError(f"No subtitles found in any of the configured languages: {lang_names}")


def save_transcript(text, video_id, lang, video_title, output_path):
    """Save transcript to markdown file."""
    clean_title = clean_filename(video_title, max_length=50)
    
    filename = CONFIG["output_filename_format"].format(
        video_id=video_id,
        lang=lang,
        title=clean_title
    )
    
    path = Path(output_path) / filename
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    return path


def browse_folder(path_var):
    """Open folder browser dialog."""
    folder = filedialog.askdirectory(initialdir=str(BASE_PATH))
    if folder:
        path_var.set(folder)


def browse_cookies_file():
    """Open file browser for cookies.txt file."""
    file = filedialog.askopenfilename(
        title="Select cookies.txt file",
        filetypes=[("Text files", "*.txt"), ("All files", "*.*")],
        initialdir=str(BASE_PATH)
    )
    if file:
        cookies_file_var.set(file)
        CONFIG["cookies_file_path"] = file


def update_progress(message, status_label, root):
    """Update progress label."""
    status_label.config(text=message)
    root.update_idletasks()


def get_selected_language_order():
    """Get the current language order from the UI listbox."""
    return [lang_listbox.get(i) for i in range(lang_listbox.size())]


def update_config_display():
    """Update the configuration display when settings change."""
    try_auto = auto_first_var.get()
    language_order = get_selected_language_order()
    
    lang_names = [CONFIG["available_languages"].get(lang, lang.upper()) for lang in language_order]
    
    if try_auto:
        sub_order = "Auto→Manual"
    else:
        sub_order = "Manual→Auto"
    
    langs_text = f"{' → '.join(lang_names)} | {sub_order}"
    subs_config_lang_label.config(text=langs_text)


def move_language_up():
    """Move selected language up in priority."""
    selection = lang_listbox.curselection()
    if not selection or selection[0] == 0:
        return
    
    idx = selection[0]
    item = lang_listbox.get(idx)
    lang_listbox.delete(idx)
    lang_listbox.insert(idx - 1, item)
    lang_listbox.selection_set(idx - 1)
    update_config_display()


def move_language_down():
    """Move selected language down in priority."""
    selection = lang_listbox.curselection()
    if not selection or selection[0] == lang_listbox.size() - 1:
        return
    
    idx = selection[0]
    item = lang_listbox.get(idx)
    lang_listbox.delete(idx)
    lang_listbox.insert(idx + 1, item)
    lang_listbox.selection_set(idx + 1)
    update_config_display()


def add_language():
    """Add a language to the priority list."""
    selected = available_lang_var.get()
    if not selected:
        return
    
    current_langs = get_selected_language_order()
    if selected in current_langs:
        messagebox.showinfo("Already Added", f"{CONFIG['available_languages'][selected]} is already in the list.")
        return
    
    lang_listbox.insert(tk.END, selected)
    update_config_display()


def remove_language():
    """Remove selected language from the priority list."""
    selection = lang_listbox.curselection()
    if not selection:
        return
    
    if lang_listbox.size() <= 1:
        messagebox.showwarning("Cannot Remove", "You must have at least one language in the list.")
        return
    
    lang_listbox.delete(selection[0])
    update_config_display()


def update_antiblock_config():
    """Update anti-block configuration from UI."""
    CONFIG["use_cookies"] = use_cookies_var.get()
    CONFIG["cookies_browser"] = browser_var.get()
    CONFIG["retry_attempts"] = int(retry_var.get())
    CONFIG["use_timedtext_fallback"] = timedtext_fallback_var.get()
    CONFIG["accept_any_language"] = accept_any_lang_var.get()


def show_available_captions():
    """Show available captions for a video."""
    url = subs_url_entry.get().strip()
    
    if not url:
        messagebox.showerror("Input Error", "Please enter a YouTube URL.")
        return
    
    def run():
        caption_window = None
        try:
            caption_tracks, video_id = get_available_captions_timedtext(url, 
                progress_callback=lambda msg: update_progress(msg, subs_status_label, root))
            
            caption_window = tk.Toplevel(root)
            caption_window.title(f"Available Captions - {video_id}")
            caption_window.geometry("600x400")
            
            frame = ttk.Frame(caption_window, padding=15)
            frame.pack(fill=tk.BOTH, expand=True)
            
            ttk.Label(frame, text=f"Available captions for: {video_id}", 
                     font=("TkDefaultFont", 11, "bold")).pack(pady=(0, 5))
            
            text_widget = scrolledtext.ScrolledText(frame, wrap=tk.WORD, width=70, height=20)
            text_widget.pack(fill=tk.BOTH, expand=True)
            
            if caption_tracks:
                text_widget.insert('1.0', f"Found {len(caption_tracks)} caption track(s):\n\n")
                for i, track in enumerate(caption_tracks, 1):
                    auto_label = " [AUTO]" if track['is_auto'] else " [MANUAL]"
                    text_widget.insert(tk.END, f"{i}. {track['lang_name']} ({track['lang_code']}){auto_label}\n")
            else:
                text_widget.insert('1.0', "No captions found for this video.")
            
            text_widget.config(state='disabled')
            
            ttk.Button(frame, text="Close", command=caption_window.destroy).pack(pady=(5, 0))
            
        except Exception as e:
            if caption_window:
                caption_window.destroy()
            messagebox.showerror("Error", f"Failed to fetch captions:\n\n{str(e)}")
        finally:
            update_progress("Ready", subs_status_label, root)
    
    threading.Thread(target=run, daemon=True).start()


def on_submit_subs():
    """Handle subtitle extraction."""
    url = subs_url_entry.get().strip()
    output_path = subs_path_var.get().strip()
    dest = subs_dest_var.get()
    language_order = get_selected_language_order()
    try_auto_first = auto_first_var.get()
    
    if not url:
        messagebox.showerror("Input Error", "Please enter a YouTube URL.")
        return
    
    if not language_order:
        messagebox.showerror("Input Error", "Please add at least one language.")
        return
    
    if dest == "file" and not output_path:
        messagebox.showerror("Input Error", "Please select an output folder.")
        return
    
    update_antiblock_config()
    
    def run():
        subs_submit_button.config(state="disabled")
        check_captions_button.config(state="disabled")
        subs_progress_bar.start()
        
        try:
            transcript, video_id, lang, video_title, sub_type = download_and_parse_subs(
                url, output_path, language_order, try_auto_first,
                progress_callback=lambda msg: update_progress(msg, subs_status_label, root)
            )
            if dest == "clipboard":
                update_progress("Copying to clipboard...", subs_status_label, root)
                root.clipboard_clear()
                root.clipboard_append(transcript)
                update_progress("Copied!", subs_status_label, root)
                lang_name = CONFIG["available_languages"].get(lang, lang.upper())
                sub_type_display = " (auto)" if sub_type == "auto" else ""
                messagebox.showinfo("Success", 
                    f"Transcript copied!\n\nLanguage: {lang_name}{sub_type_display}\nTitle: {video_title}")
            else:
                update_progress("Saving...", subs_status_label, root)
                path = save_transcript(transcript, video_id, lang, video_title, output_path)
                update_progress("Success!", subs_status_label, root)
                lang_name = CONFIG["available_languages"].get(lang, lang.upper())
                sub_type_display = " (auto)" if sub_type == "auto" else ""
                messagebox.showinfo("Success", 
                    f"Transcript saved!\n\nFile: {path.name}\nLanguage: {lang_name}{sub_type_display}\nLocation: {path}")
        except Exception as e:
            update_progress("Error", subs_status_label, root)
            messagebox.showerror("Error", f"Failed:\n\n{str(e)}")
        finally:
            subs_submit_button.config(state="disabled" if not yt_dlp_available else "normal")
            check_captions_button.config(state="normal")
            subs_progress_bar.stop()
            update_progress("Ready", subs_status_label, root)
    
    threading.Thread(target=run, daemon=True).start()


def on_submit_video():
    """Handle video download."""
    url = video_url_entry.get().strip()
    output_path = video_path_var.get().strip()
    max_res = video_res_var.get()
    
    if not url:
        messagebox.showerror("Input Error", "Please enter a YouTube URL.")
        return
    
    if not output_path:
        messagebox.showerror("Input Error", "Please select an output folder.")
        return
    
    update_antiblock_config()
    
    def run():
        video_submit_button.config(state="disabled")
        video_progress_bar.start()
        
        try:
            file_path, video_title = download_video(
                url, output_path, max_res,
                progress_callback=lambda msg: update_progress(msg, video_status_label, root)
            )
            update_progress("Success!", video_status_label, root)
            messagebox.showinfo("Success", 
                f"Video downloaded!\n\nTitle: {video_title}\nFile: {file_path.name}\nLocation: {file_path}")
        except Exception as e:
            update_progress("Error", video_status_label, root)
            messagebox.showerror("Error", f"Failed:\n\n{str(e)}")
        finally:
            video_submit_button.config(state="disabled" if not yt_dlp_available else "normal")
            video_progress_bar.stop()
            update_progress("Ready", video_status_label, root)
    
    threading.Thread(target=run, daemon=True).start()


# ==================== UI (COMPACT) ====================
root = tk.Tk()
root.title("YouTube Downloader")
root.geometry("475x950")
root.resizable(True, True)
yt_dlp_available, version, ejs_available = check_yt_dlp()
# Create main scrollable canvas
canvas = tk.Canvas(root)
scrollbar = ttk.Scrollbar(root, orient="vertical", command=canvas.yview)
scrollable_frame = ttk.Frame(canvas)
scrollable_frame.bind(
    "<Configure>",
    lambda e: canvas.configure(scrollregion=canvas.bbox("all"))
)
canvas.create_window((0, 0), window=scrollable_frame, anchor="nw")
canvas.configure(yscrollcommand=scrollbar.set)
# Pack canvas and scrollbar
canvas.pack(side="left", fill="both", expand=True)
scrollbar.pack(side="right", fill="y")
# Mouse wheel scrolling
def _on_mousewheel(event):
    canvas.yview_scroll(int(-1*(event.delta/120)), "units")
canvas.bind_all("<MouseWheel>", _on_mousewheel)
main_frame = ttk.Frame(scrollable_frame, padding=10)
main_frame.pack(fill=tk.BOTH, expand=True)
ttk.Label(main_frame, text="YouTube Downloader", 
         font=("TkDefaultFont", 14, "bold")).pack(pady=(0, 5))
if yt_dlp_available:
    ttk.Label(main_frame, text=f"✓ yt-dlp {version}",
              foreground="green", font=("TkDefaultFont", 8)).pack(anchor="w")
    if not ejs_available:
        ttk.Label(main_frame,
                  text='⚠ yt-dlp-ejs missing — YouTube may fail. Run: pip install -U "yt-dlp[default]"',
                  foreground="orange", font=("TkDefaultFont", 8), wraplength=440).pack(anchor="w")
else:
    ttk.Label(main_frame, text="⚠ yt-dlp not found",
              foreground="red", font=("TkDefaultFont", 8)).pack(anchor="w")
# Anti-block settings (COMPACT)
antiblock_frame = ttk.LabelFrame(main_frame, text="🛡️ Anti-Block", padding=5)
antiblock_frame.pack(fill=tk.X, pady=(5, 5))
use_cookies_var = tk.BooleanVar(value=CONFIG["use_cookies"])
ttk.Checkbutton(antiblock_frame, text="Use cookies", 
                variable=use_cookies_var).pack(anchor="w")
row1 = ttk.Frame(antiblock_frame)
row1.pack(fill=tk.X, pady=(2, 2))
ttk.Label(row1, text="Browser:").pack(side=tk.LEFT)
browser_var = tk.StringVar(value=CONFIG["cookies_browser"])
ttk.Combobox(row1, textvariable=browser_var,
            values=["firefox", "chrome", "edge", "safari", "opera"],
            state="readonly", width=10).pack(side=tk.LEFT, padx=(5, 10))
ttk.Label(row1, text="Retries:").pack(side=tk.LEFT)
retry_var = tk.StringVar(value=str(CONFIG["retry_attempts"]))
ttk.Spinbox(row1, from_=1, to=10, textvariable=retry_var, width=5).pack(side=tk.LEFT, padx=(5, 0))
timedtext_fallback_var = tk.BooleanVar(value=CONFIG["use_timedtext_fallback"])
ttk.Checkbutton(antiblock_frame, text="TimedText fallback (when yt-dlp fails)", 
                variable=timedtext_fallback_var).pack(anchor="w")
accept_any_lang_var = tk.BooleanVar(value=CONFIG["accept_any_language"])
ttk.Checkbutton(antiblock_frame, text="Accept any language if preferred not found", 
                variable=accept_any_lang_var).pack(anchor="w")
notebook = ttk.Notebook(main_frame)
notebook.pack(fill=tk.BOTH, expand=True, pady=(5, 5))
# ==================== SUBTITLES TAB (COMPACT) ====================
subs_frame = ttk.Frame(notebook, padding=8)
notebook.add(subs_frame, text="Subtitles")
# Language priority (COMPACT)
lang_frame = ttk.LabelFrame(subs_frame, text="Language Priority", padding=5)
lang_frame.pack(fill=tk.X, pady=(0, 5))
lang_container = ttk.Frame(lang_frame)
lang_container.pack(fill=tk.X)
left_frame = ttk.Frame(lang_container)
left_frame.pack(side=tk.LEFT, fill=tk.BOTH, expand=True, padx=(0, 5))
lang_listbox = tk.Listbox(left_frame, height=3, selectmode=tk.SINGLE)
lang_listbox.pack(fill=tk.BOTH, expand=True, pady=(0, 3))
for lang in CONFIG["default_language_order"]:
    lang_listbox.insert(tk.END, lang)
button_frame = ttk.Frame(left_frame)
button_frame.pack(fill=tk.X)
ttk.Button(button_frame, text="↑", command=move_language_up, width=4).pack(side=tk.LEFT, padx=(0, 2))
ttk.Button(button_frame, text="↓", command=move_language_down, width=4).pack(side=tk.LEFT, padx=(0, 2))
ttk.Button(button_frame, text="✕", command=remove_language, width=4).pack(side=tk.LEFT)
right_frame = ttk.Frame(lang_container)
right_frame.pack(side=tk.LEFT, fill=tk.Y)
ttk.Label(right_frame, text="Add:", font=("TkDefaultFont", 8)).pack(anchor="w")
available_lang_var = tk.StringVar()
lang_dropdown = ttk.Combobox(right_frame, textvariable=available_lang_var, 
                             values=list(CONFIG["available_languages"].keys()),
                             state="readonly", width=8)
lang_dropdown.pack(pady=(2, 2))
ttk.Button(right_frame, text="+", command=add_language, width=4).pack()
lang_listbox.bind('<<ListboxSelect>>', lambda e: update_config_display())
auto_first_var = tk.BooleanVar(value=CONFIG["try_auto_first"])
ttk.Checkbutton(lang_frame, text="Try auto-generated first", 
                variable=auto_first_var, command=update_config_display).pack(anchor="w", pady=(3, 0))
# Output destination (COMPACT)
dest_row = ttk.Frame(subs_frame)
dest_row.pack(fill=tk.X, pady=(0, 3))
ttk.Label(dest_row, text="Output:", font=("TkDefaultFont", 8)).pack(side=tk.LEFT, padx=(0, 5))
subs_dest_var = tk.StringVar(value="clipboard")
ttk.Radiobutton(dest_row, text="Clipboard", variable=subs_dest_var, value="clipboard").pack(side=tk.LEFT)
ttk.Radiobutton(dest_row, text="File", variable=subs_dest_var, value="file").pack(side=tk.LEFT, padx=(5, 0))
# Config display
config_frame = ttk.LabelFrame(subs_frame, text="Config", padding=3)
config_frame.pack(fill=tk.X, pady=(0, 5))
subs_config_lang_label = ttk.Label(config_frame, text="", font=("TkDefaultFont", 8))
subs_config_lang_label.pack(anchor="w")
update_config_display()
# URL
subs_url_frame = ttk.LabelFrame(subs_frame, text="YouTube URL", padding=3)
subs_url_frame.pack(fill=tk.X, pady=(0, 3))
subs_url_entry = ttk.Entry(subs_url_frame, font=("TkDefaultFont", 9))
subs_url_entry.pack(fill=tk.X)
check_captions_button = ttk.Button(subs_frame, text="🔍 Check Captions", command=show_available_captions)
check_captions_button.pack(pady=(0, 3))
# Output path
subs_path_frame = ttk.LabelFrame(subs_frame, text="Output Folder", padding=3)
subs_path_frame.pack(fill=tk.X, pady=(0, 5))
subs_path_input_frame = ttk.Frame(subs_path_frame)
subs_path_input_frame.pack(fill=tk.X)
subs_path_var = tk.StringVar(value=str(BASE_PATH))
subs_path_entry = ttk.Entry(subs_path_input_frame, textvariable=subs_path_var, font=("TkDefaultFont", 8))
subs_path_entry.pack(side=tk.LEFT, fill=tk.X, expand=True)
ttk.Button(subs_path_input_frame, text="...", command=lambda: browse_folder(subs_path_var), 
          width=3).pack(side=tk.RIGHT, padx=(3, 0))
subs_submit_button = ttk.Button(subs_frame, text="Extract Subtitles", command=on_submit_subs)
subs_submit_button.pack(pady=5)
if not yt_dlp_available:
    subs_submit_button.config(state="disabled")
subs_progress_bar = ttk.Progressbar(subs_frame, mode='indeterminate')
subs_progress_bar.pack(fill=tk.X, pady=(0, 2))
subs_status_label = ttk.Label(subs_frame, text="Ready", font=("TkDefaultFont", 8))
subs_status_label.pack()
# ==================== VIDEO TAB (COMPACT) ====================
video_frame = ttk.Frame(notebook, padding=8)
notebook.add(video_frame, text="Video")
video_config_frame = ttk.LabelFrame(video_frame, text="Video Config", padding=5)
video_config_frame.pack(fill=tk.X, pady=(0, 5))
res_row = ttk.Frame(video_config_frame)
res_row.pack(fill=tk.X)
ttk.Label(res_row, text="Max Resolution:").pack(side=tk.LEFT)
video_res_var = tk.StringVar(value=CONFIG["max_resolution"])
ttk.Combobox(res_row, textvariable=video_res_var, values=["1080", "720", "480", "360"],
            state="readonly", width=8).pack(side=tk.LEFT, padx=(5, 0))
video_url_frame = ttk.LabelFrame(video_frame, text="YouTube URL", padding=3)
video_url_frame.pack(fill=tk.X, pady=(0, 5))
video_url_entry = ttk.Entry(video_url_frame, font=("TkDefaultFont", 9))
video_url_entry.pack(fill=tk.X)
video_path_frame = ttk.LabelFrame(video_frame, text="Output Folder", padding=3)
video_path_frame.pack(fill=tk.X, pady=(0, 5))
video_path_input_frame = ttk.Frame(video_path_frame)
video_path_input_frame.pack(fill=tk.X)
video_path_var = tk.StringVar(value=str(BASE_PATH))
video_path_entry = ttk.Entry(video_path_input_frame, textvariable=video_path_var, font=("TkDefaultFont", 8))
video_path_entry.pack(side=tk.LEFT, fill=tk.X, expand=True)
ttk.Button(video_path_input_frame, text="...", command=lambda: browse_folder(video_path_var),
          width=3).pack(side=tk.RIGHT, padx=(3, 0))
video_submit_button = ttk.Button(video_frame, text="Download Video", command=on_submit_video)
video_submit_button.pack(pady=5)
if not yt_dlp_available:
    video_submit_button.config(state="disabled")
video_progress_bar = ttk.Progressbar(video_frame, mode='indeterminate')
video_progress_bar.pack(fill=tk.X, pady=(0, 2))
video_status_label = ttk.Label(video_frame, text="Ready", font=("TkDefaultFont", 8))
video_status_label.pack()
# Instructions (COMPACT)
instructions_frame = ttk.LabelFrame(main_frame, text="Info", padding=5)
instructions_frame.pack(fill=tk.X, pady=(2, 0))
instructions_text = """• Check Captions: See all available subtitle tracks
• TimedText Fallback: Direct API when yt-dlp fails
• Accept Any Language: Download first available if preferred not found
• Browser Cookies: Best anti-block protection"""
ttk.Label(instructions_frame, text=instructions_text, justify=tk.LEFT, 
         font=("TkDefaultFont", 8)).pack(anchor="w")
# Cookie file browser (hidden by default, add if needed)
cookies_file_var = tk.StringVar(value="")
root.mainloop()
