# Muxes raw.webm with the narration and burns in karaoke captions (each word fills in as it is spoken).
#   python3 build.py <out.mp4>
import json, subprocess, sys

timing = json.load(open("timing.json"))
m = json.load(open("marks.json"))
marks, end = m["marks"], m["end"]
out = sys.argv[1]
OFFSET = 0.0  # video starts with the context; marks are measured from the same instant

def ts(t):
  t = max(0, t); h = int(t // 3600); mi = int(t % 3600 // 60); s = t % 60
  return f"{h}:{mi:02d}:{s:05.2f}"

ass = ["[Script Info]", "ScriptType: v4.00+", "PlayResX: 1280", "PlayResY: 720", "WrapStyle: 0", "ScaledBorderAndShadow: yes", "",
  "[V4+ Styles]",
  "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
  # Primary = spoken (warm yellow), Secondary = not yet spoken (white). Colours are &HAABBGGRR.
  "Style: Cap,DejaVu Sans,34,&H004DD8FF,&H00FFFFFF,&H30000000,&H30000000,-1,0,0,0,100,100,0,0,3,9,0,2,90,90,30,1",
  "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text"]
for sec, mark in zip(timing, marks):
  for line in sec["lines"]:
    base = mark + OFFSET
    start, stop = base + line["s"], base + line["e"] + 0.2
    parts, cursor = [], line["s"]
    for w in line["words"]:
      lead = max(0, w["s"] - cursor)
      if lead > 0.005: parts.append(f"{{\\k{round(lead*100)}}}")
      parts.append(f"{{\\kf{max(1, round((w['e'] - w['s']) * 100))}}}{w['w'].replace('{', '(').replace('}', ')')} ")
      cursor = w["e"]
    ass.append(f"Dialogue: 0,{ts(start)},{ts(stop)},Cap,,0,0,0,,{{\\fad(120,120)}}" + "".join(parts).rstrip())
open("captions.ass", "w").write("\n".join(ass) + "\n")

inputs, filters = ["-i", "raw.webm"], []
for i, mark in enumerate(marks):
  inputs += ["-i", f"sec{i+1}.wav"]
  filters.append(f"[{i+1}:a]adelay={round((mark + OFFSET) * 1000)}:all=1[a{i}]")
mix = "".join(f"[a{i}]" for i in range(len(marks)))
filters.append(f"{mix}amix=inputs={len(marks)}:normalize=0:dropout_transition=0,apad,atrim=0:{end:.2f},loudnorm=I=-16:TP=-1.5:LRA=11[aout]")
filters.append("[0:v]scale=1280:720:flags=lanczos,fps=30,ass=captions.ass[vout]")
cmd = ["ffmpeg", "-y", "-loglevel", "error", *inputs, "-filter_complex", ";".join(filters), "-map", "[vout]", "-map", "[aout]",
  "-t", f"{end:.2f}", "-c:v", "libx264", "-preset", "medium", "-crf", "22", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k",
  "-ar", "48000", "-movflags", "+faststart", out]
subprocess.run(cmd, check=True)
print("wrote", out)
