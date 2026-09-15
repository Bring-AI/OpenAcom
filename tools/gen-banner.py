# Generate the AgentRelay repo banner (docs-quality, dark theme, hub-and-spoke).
# Output: banner.png at repo root (referenced at the top of README.md).
from PIL import Image, ImageDraw, ImageFont

W, H = 1920, 480
SS = 2  # supersample
w, h = W * SS, H * SS

BG = (11, 18, 32)
BOX_FILL = (22, 31, 46)
BOX_BORDER = (66, 104, 160)
BOX_TEXT = (230, 237, 243)
LABEL = (155, 170, 192)
HUB_FILL = (15, 42, 74)
HUB_BORDER = (76, 141, 255)
ACCENT = (76, 141, 255)
LINE = (86, 116, 165)
TAGLINE = (174, 188, 208)
TITLE = (240, 246, 252)

F = "C:/Windows/Fonts/"
def font(name, size):
    return ImageFont.truetype(F + name, size * SS)

title_f = font("seguisb.ttf", 58)
tag_f = font("segoeui.ttf", 21)
box_f = font("seguisb.ttf", 22)
hub_f = font("seguisb.ttf", 30)
hub2_f = font("segoeui.ttf", 19)
side_f = font("seguisb.ttf", 17)

img = Image.new("RGB", (w, h), BG)
d = ImageDraw.Draw(img)

def ctext(x, y, s, f, fill, anchor="mm"):
    d.text((x * SS, y * SS), s, font=f, fill=fill, anchor=anchor)

# ---- left panel: title + tagline ----
LX = 84
ctext(LX, 108, "AgentRelay", title_f, TITLE, anchor="lm")
d.rectangle([LX * SS, (108 + 44) * SS, (LX + 96) * SS, (108 + 47) * SS], fill=ACCENT)

tag = ("One MCP/CLI command managing agent\n"
       "sessions across desktops and CLIs on\n"
       "different local/remote machines.")
ty = 196
for line in tag.split("\n"):
    ctext(LX, ty, line, tag_f, TAGLINE, anchor="lm")
    ty += 34

ctext(LX, 372, "CLAUDE CODE   ·   CODEX   ·   ZCODE", side_f, LABEL, anchor="lm")
ctext(LX, 408, "list  ·  read  ·  send  ·  MCP  ·  HTTP", side_f, (94, 110, 133), anchor="lm")

# ---- right panel: hub and spoke ----
hub_x, hub_y = 1270, 240
R = 88
d.ellipse([(hub_x - R) * SS, (hub_y - R) * SS, (hub_x + R) * SS, (hub_y + R) * SS],
          fill=HUB_FILL, outline=HUB_BORDER, width=3 * SS)
ctext(hub_x, hub_y - 16, "AgentRelay", hub_f, TITLE)
ctext(hub_x, hub_y + 22, "MCP · CLI", hub2_f, TAGLINE)

BW, BH = 190, 56
def box(cx, cy, label):
    x0, y0 = cx - BW / 2, cy - BH / 2
    d.rounded_rectangle([x0 * SS, y0 * SS, (x0 + BW) * SS, (y0 + BH) * SS],
                        radius=12 * SS, fill=BOX_FILL, outline=BOX_BORDER, width=2 * SS)
    ctext(cx, cy, label, box_f, BOX_TEXT)
    return (x0 + BW, y0 + BH / 2) if cx < hub_x else (x0, y0 + BH / 2)

local = [(900, 84, "Claude Code"), (900, 240, "Codex"), (900, 396, "ZCode")]
remote = [(1640, 130, "Claude · SSH"), (1640, 350, "Remote agents")]

for cx, cy, label in local + remote:
    ex, ey = box(cx, cy, label)
    # connect edge to hub circle edge
    import math
    dx, dy = hub_x - ex, hub_y - ey
    L = math.hypot(dx, dy)
    tx, ty = hub_x - dx / L * (R + 4), hub_y - dy / L * (R + 4)
    d.line([ex * SS, ey * SS, tx * SS, ty * SS], fill=LINE, width=3 * SS)
    d.ellipse([(ex - 3.5) * SS, (ey - 3.5) * SS, (ex + 3.5) * SS, (ey + 3.5) * SS], fill=ACCENT)

ctext(900, 34, "LOCAL", side_f, LABEL)
ctext(1640, 34, "REMOTE", side_f, LABEL)

img = img.resize((W, H), Image.LANCZOS)
img.save("banner.png")
print("banner.png saved", img.size)
